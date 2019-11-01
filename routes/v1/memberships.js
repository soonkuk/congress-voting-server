const express = require('express');
const createError = require('http-errors');
const { hash, verify } = require('sebakjs-util');
const debug = require('debug')('voting:routes:membership');
const { Membership, Proposal } = require('../../models/index');
const { underscored } = require('../utils');
const {
  getToken,
  getApplicantStatus,
  // doApplicantRequest,
  getAccessToken,
  getApplicant,
  getApplicantByAddress,
} = require('../../lib/sumsub');
const { currentHeight, getFrozenAccounts } = require('../../lib/sebak');

const { SEBAK_NETWORKID = 'sebak-test-network' } = process.env;

const router = express.Router();

let bearerToken;
let tokenCretedTime;

// Days are converted to milliseconds
// 24 hours * 60 minutes * 60 seconds *1000 milliseconds * 3 days = 259200000
const tokenExpireDuration = 259200000;

const isTokenExpired = () => {
  const nowTime = Date.now();
  if ((nowTime - tokenCretedTime) >= tokenExpireDuration) {
    tokenCretedTime = Date.now();
    return true;
  }
  return false;
};

const init = (async () => {
  bearerToken = await getToken();
  tokenCretedTime = Date.now();
});

init();

// create new membership (signature required)
router.post('/memberships', async (req, res, next) => {
  try {
    debug('POST /memberships %o', req.body);
    if (!req.body.data) {
      return next(createError(400, 'there is no data'));
    }

    const [publicAddress] = req.body.data;
    if (!publicAddress) {
      return next(createError(400, 'public address is required.'));
    }

    // check signature
    const verified = verify(
      hash(req.body.data),
      SEBAK_NETWORKID,
      req.body.signature,
      publicAddress,
    );
    if (!verified) {
      return next(createError(400, 'The signature is invalid.'));
    }


    const m = await Membership.findByAddress(publicAddress);

    if (m
      && (m.status === Membership.Status.init.name || m.status === Membership.Status.rejected.name)
    ) { // keep to progress KYC
      return res.json(underscored(m.toJSON()));
    }
    if (m && m.status !== Membership.Status.init.name) {
      return next(createError(409, 'The address is already registered'));
    }

    const member = await Membership.register({
      publicAddress,
      status: Membership.Status.init.name,
    }, req.body.signature);
    return res.json(underscored(member.toJSON()));
  } catch (err) {
    return next(err);
  }
});

// callback to get verification result from Sub&Substance
router.post('/memberships/sumsub/callback', async (req, res, next) => {
  if (isTokenExpired()) {
    bearerToken = await getToken();
  }
  const token = bearerToken;
  try {
    debug('POST /memberships/sumsub/callback %o', req.body);
    if (req.body.type === 'INSPECTION_REVIEW_COMPLETED') {
      // externalUserId is public address
      const m = await Membership.findByAddress(req.body.externalUserId);
      if (!m) { return res.json({}); }

      if (!m.applicantId) {
        const applicantData = await getApplicantByAddress(token, req.body.externalUserId);
        if (applicantData && applicantData.id) {
          await m.pend(applicantData.id);
        }
      }

      if (req.body.review && req.body.review.reviewAnswer === 'GREEN') {
        // verification passed
        await m.verify();
      } else if (req.body.review && req.body.review.reviewAnswer === 'RED') {
        // verification failed
        await m.reject();
      }
    } else if (req.body.type === 'JOB_FINISHED') {
      const applicantData = await getApplicant(token, req.body.applicantId);
      if (applicantData && applicantData.externalUserId) {
        const m = await Membership.findByAddress(applicantData.externalUserId);
        if (!m) { return res.json({}); }
        if (!m.applicantId) {
          if (applicantData.review.reviewStatus === 'init') {
            await m.init(req.body.applicantId);
          } else if (applicantData.review.reviewStatus === 'pending') {
            await m.pend(req.body.applicantId);
          }
        }
      }
    }

    return res.json({});
  } catch (err) {
    if (err.statusCode === 401 && err.statusMessage === 'Unauthorized') {
      bearerToken = await getToken();
    }
    return next(err);
  }
});

// obtain access token from sum&sub
router.get('/memberships/sumsub/access-token/:address', async (req, res, next) => {
  try {
    // const applicantRequstStatus = await doApplicantRequest(apiKey);
    // if (applicantRequstStatus === false) {
    //  throw new Error('Failed to applicantRequest');
    // }

    debug('GET /memberships/sumsub/access-token/:address %s', req.params.address);
    if (isTokenExpired()) {
      bearerToken = await getToken();
    }
    const token = bearerToken;
    const accessToken = await getAccessToken(token, req.params.address);
    const body = { data: `${accessToken}` };
    return res.json(body);
  } catch (err) {
    if (err.statusCode === 401 && err.statusMessage === 'Unauthorized') {
      bearerToken = await getToken();
    }
    return next(err);
  }
});

// find an existing membership
router.get('/memberships/:address', async (req, res, next) => {
  if (isTokenExpired()) {
    bearerToken = await getToken();
  }
  const token = bearerToken;
  try {
    debug('GET /memberships/:address %s', req.params.address);
    const m = await Membership.findByAddress(req.params.address);
    if (!m) { return next(createError(404, 'The address does not exist.')); }
    const tempResult = await getApplicantStatus(token, m.applicantId);
    console.log("temp result :", tempResult);
    const now = new Date();
    // SUMSUB_RENEW_INTERVAL is msec
    now.setMilliseconds(now.getMilliseconds() - (process.env.SUMSUB_RENEW_INTERVAL || 1));
    if (
      (m.status === Membership.Status.init.name || m.status === Membership.Status.pending.name)
       && m.updatedAt < now
    ) {
      if (!m.applicantId) {
        const applicantData = await getApplicantByAddress(token, m.publicAddress);
        if (applicantData && applicantData.id) {
          await m.pend(applicantData.id);
          const result = await getApplicantStatus(token, m.applicantId);
          if (result === 'verified') { await m.verify(); }
          if (result === 'rejected') { await m.reject(); }
          if (result === 'pending') { await m.pend(); }
          await m.reload();
        }
      } else if (m.applicantId) {
        const result = await getApplicantStatus(token, m.applicantId);
        if (result === 'verified') { await m.verify(); }
        if (result === 'rejected') { await m.reject(); }
        if (result === 'pending') { await m.pend(); }
        await m.reload();
      }
    }

    return res.json(underscored(m.toJSON()));
  } catch (err) {
    if (err.statusCode === 401 && err.statusMessage === 'Unauthorized') {
      bearerToken = await getToken();
    }
    return next(err);
  }
});

// update membership information
// currently only for applicantId
router.put('/memberships/:address', async (req, res, next) => {
  try {
    debug('PUT /memberships/:address %s %o', req.params.address, req.body);
    const addr = req.params.address;
    if (!req.body.data) {
      return next(createError(400, 'there is no data'));
    }

    const [publicAddress, applicantId] = req.body.data;
    if (!publicAddress) {
      return next(createError(400, 'The public address is required.'));
    }
    if (!applicantId) {
      return next(createError(400, 'The applicant id is required.'));
    }
    if (publicAddress !== addr) {
      return next(createError(400, 'The public address is not matched.'));
    }

    // check signature
    const verified = verify(
      hash(req.body.data),
      SEBAK_NETWORKID,
      req.body.signature,
      publicAddress,
    );
    if (!verified) {
      return next(createError(400, 'The signature is invalid.'));
    }

    const m = await Membership.findByAddress(req.params.address);
    if (m.status === Membership.Status.rejected.name && applicantId === 'ApplicantResubmitted') {
      m.pend();
      return res.json(underscored(m.toJSON()));
    }

    if (isTokenExpired()) {
      bearerToken = await getToken();
    }
    const token = bearerToken;
    const result = await getApplicantStatus(token, applicantId);

    if (m.status === Membership.Status.init.name) {
      if (result === 'init') {
        m.init(applicantId);
      } else {
        m.pend(applicantId);
      }
    } else if (m.status === Membership.Status.rejected.name && applicantId === 'ApplicantResubmitted') {
      m.pend();
    }

    return res.json(underscored(m.toJSON()));
  } catch (err) {
    if (err.statusCode === 401 && err.statusMessage === 'Unauthorized') {
      bearerToken = await getToken();
    }
    return next(err);
  }
});

// delete an existing membership (signature required)
router.delete('/memberships/:address', async (req, res, next) => {
  debug('DELETE /memberships/:address %s %s', req.params.address, req.query.sig);
  try {
    const addr = req.params.address;
    const { sig } = req.query;

    if (!sig) {
      return next(createError(400, 'The signature is required.'));
    }

    const m = await Membership.findByAddress(addr);
    if (!m) { return next(createError(404, 'The address does not exist.')); }

    // check signature
    const verified = verify(hash([addr]), SEBAK_NETWORKID, sig, addr);
    if (!verified) {
      return next(createError(400, 'The signature is invalid.'));
    }

    const height = await currentHeight();
    const prs = await Proposal.listOpened(height);
    if (prs.length > 0) {
      return next(createError(400, 'Deregistering mebership is impossible if there are opened votes.'));
    }
    await m.deactivate(height, sig);

    return res.json(underscored(m.toJSON()));
  } catch (err) {
    return next(err);
  }
});

// activate an existing membership
router.post('/memberships/:address/activate', async (req, res, next) => {
  try {
    debug('POST /memberships/:address/activate %s %o', req.params.address, req.body);
    const m = await Membership.findByAddress(req.params.address);
    if (!m) { return next(createError(404, 'The address does not exist.')); }
    // check frozen accounts in sebak
    const accounts = await getFrozenAccounts(req.params.address);
    const hasFrozen = accounts && accounts._embedded // eslint-disable-line no-underscore-dangle
      && accounts._embedded.records // eslint-disable-line no-underscore-dangle
      && accounts._embedded.records.some(r => r.state === 'frozen' || r.state === 'melting'); // eslint-disable-line no-underscore-dangle
    if (!hasFrozen) {
      return next(createError(400, 'There is no frozen account'));
    }
    const height = await currentHeight();
    await m.activate(height, req.body.signature);

    if (m.status !== Membership.Status.active.name) {
      return next(createError(400, 'The membership status is incorrect.'));
    }

    return res.json(underscored(m.toJSON()));
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
