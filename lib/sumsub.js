const got = require('got');
const debug = require('debug')('voting:lib:sumsub');

const { SUMSUB_USERNAME, SUMSUB_PASSWORD } = process.env;
const SUMSUB_HOST = process.env.SUMSUB_HOST || 'https://test-api.sumsub.com';

module.exports = {
  getToken: async () => {
    const auth = "Basic " + new Buffer.from(SUMSUB_USERNAME + ":" + SUMSUB_PASSWORD).toString("base64");
    const client = got.extend({
      baseUrl: `${SUMSUB_HOST}`,
      headers: { Authorization: `${auth}` },
    });
    try {
      const res = await client.post('/resources/auth/login', { json: true });
      debug('getToken %o', res.body);
      const token = res.body.payload;
      return token;
    } catch (err) {
      return null;
    }
  },
  getApplicantStatus: async (token, applicantId) => {
    console.log("bearer token :", token);
    const auth = "Bearer " + token;
    const client = got.extend({
      baseUrl: `${SUMSUB_HOST}`,
      headers: {
        Authorization: `${auth}`,
        Accept: 'application/json',
        'Content-type': 'application/json',
      },
    });
    const res = await client.get(`${SUMSUB_HOST}/resources/applicants/${applicantId}/state`, { json: true });
    debug('getApplicantStatus %s %o', applicantId, res.body);

    if (res.body.status && res.body.status.reviewResult && res.body.status.reviewResult.reviewAnswer === 'GREEN') {
      return 'verified';
    }
    if (res.body.status && res.body.status.reviewResult && res.body.status.reviewResult.reviewAnswer === 'RED') {
      return 'rejected';
    }
    if (res.body.status && res.body.status.reviewStatus === 'pending') {
      return 'pending';
    }
    if (res.body.status && res.body.status.reviewStatus === 'init') {
      return 'init';
    }

    return null;
  },
  doApplicantRequest: async (token, address) => {
    const auth = 'Bearer ' + token;
    const data = {
      description: '',
      applicant: {
        email: '',
        requiredIdDocs: {
          docSets: [
            {
              idDocSetType: 'IDENTITY',
              types: [
                'ID_CARD',
                'PASSPORT',
                'DRIVERS',
                'RESIDENCE_PERMIT',
              ],
              fields: null,
            },
            {
              idDocSetType: 'SELFIE',
              types: ['SELFIE'],
              fields: null,
            }
          ]
        },
        externalUserId: `${address}`,
      },
    };
    const client = got.extend({
      baseUrl: `${SUMSUB_HOST}`,
      headers: {
        Authorization: `${auth}`,
        Accept: 'application/json',
        'Content-type': 'application/json',
      },
    });

    try {
      const r = await client.post('/resources/accounts/-/applicantRequests',
        {
          body: JSON.stringify(data),
        });
      if (r.statusCode === 204) {
        return true;
      }
    } catch (err) {
      return false;
    }
    return false;
  },
  getAccessToken: async (token, address) => {
    const auth = "Bearer " + token;
    const client = got.extend({
      baseUrl: `${SUMSUB_HOST}`,
      headers: {
        Authorization: `${auth}`,
        Accept: 'application/json',
        'Content-type': 'application/json',
      },
    });
    try {
      const res = await client.post('/resources/accessTokens?userId=' + `${address}` + '&ttlInSecs=1800', { json: true });
      debug('getAccessToken %s %o', address, res.body);
      const accessToken = res.body.token;
      return accessToken;
    } catch (err) {
      return null;
    }
  },
  getApplicant: async (token, applicantId) => {
    const auth = 'Bearer ' + token;
    const client = got.extend({
      baseUrl: `${SUMSUB_HOST}`,
      headers: {
        Authorization: `${auth}`,
        Accept: 'application/json',
        'Content-type': 'application/json',
      },
    });
    const res = await client.get(`${SUMSUB_HOST}/resources/applicants/${applicantId}`, { json: true });
    debug('getApplicant %s %o', applicantId, res.body);

    if (res.body.list && res.body.list.items && res.body.list.items.length > 0) {
      return res.body.list.items[0];
    }

    return null;
  },
  getApplicantByAddress: async (token, address) => {
    const auth = 'Bearer ' + token;
    const client = got.extend({
      baseUrl: `${SUMSUB_HOST}`,
      headers: {
        Authorization: `${auth}`,
        Accept: 'application/json',
        'Content-type': 'application/json',
      },
    });
    const res = await client.get(`${SUMSUB_HOST}/resources/applicants/-;externalUserId=${address}}`, { json: true });
    debug('getApplicantByAddress %s %o', address, res.body);
    if (res.body.list && res.body.list.items && res.body.list.items.length > 0) {
      return res.body.list.items[0];
    }

    return null;
  },
};
