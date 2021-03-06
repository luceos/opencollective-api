import config from 'config';
import request from 'request-promise';
import Promise from 'bluebird';
import models, { Op } from '../models';
import errors from '../lib/errors';
import paymentProviders from '../paymentProviders';
import { get } from 'lodash';

const {
  ConnectedAccount,
  User
} = models;

export const list = (req, res, next) => {
  const slug = req.params.slug.toLowerCase();

  models.Collective.findBySlug(slug)
    .then(collective => {
      return models.ConnectedAccount.findAll({
        where: { CollectiveId: collective.id }
      });
    })
    .map(connectedAccount => connectedAccount.info)
    .tap(connectedAccounts => res.json({connectedAccounts}))
    .catch(next);
};

export const createOrUpdate = (req, res, next, accessToken, data, emails) => {
  const { utm_source, redirect } = req.query;
  const { service } = req.params;
  const attrs = { service };

  switch (service) {

    case 'github': {
      let fetchUserPromise, caId, user, userCollective;
      const profile = data.profile._json;
      const image = `https://images.githubusercontent.com/${data.profile.username}`;
      // TODO should simplify using findOrCreate but need to upgrade Sequelize to have this fix:
      // https://github.com/sequelize/sequelize/issues/4631
      if (req.remoteUser) {
        fetchUserPromise = Promise.resolve(req.remoteUser);
      } else {
        fetchUserPromise = User.findOne({ where: { email: { [Op.in]: emails.map(email => email.toLowerCase()) } } })
        .then(u => u || User.createUserWithCollective({
          name: profile.name || profile.login,
          image,
          email: emails[0],
        }))
      }
      return fetchUserPromise
        .then(u => {
          user = u;
          attrs.CollectiveId = user.CollectiveId;
          attrs.clientId = profile.id;
          attrs.data = profile;
          attrs.CreatedByUserId = user.id;
          return models.Collective.findById(user.CollectiveId);
        })
        .then(c => {
          userCollective = c;
          userCollective.description = userCollective.description || profile.bio;
          userCollective.locationName = userCollective.locationName || profile.location;
          userCollective.website = userCollective.website || profile.blog || profile.html_url;
          userCollective.image = userCollective.image || image;
          userCollective.save();
        })
        .then(() => ConnectedAccount.findOne({ where: { service, CollectiveId: user.CollectiveId} }))
        .then(ca => ca || ConnectedAccount.create(attrs))
        .then(ca => {
          caId = ca.id;
          return ca.update({ username: data.profile.username, token: accessToken });
        })
        .then(() => {
          const token = user.generateConnectedAccountVerifiedToken(caId, data.profile.username);
          res.redirect(redirect || `${config.host.website}/github/apply/${token}?utm_source=${utm_source}`);
        })
        .catch(next);
    }

    case 'meetup':
      return createConnectedAccountForCollective(req.query.CollectiveId, service)
        .then(ca => ca.update({
          clientId: accessToken,
          token: data.tokenSecret,
          CreatedByUserId: req.remoteUser.id
        }))
        .then(() => res.redirect(redirect || `${config.host.website}/${req.query.slug}/edit#connectedAccounts`))
        .catch(next);

    case 'twitter': {
      let collective;
      const profile = data.profile._json;

      return models.Collective.findById(req.query.CollectiveId)
        .then(c => {
          collective = c;
          collective.image = collective.image || (profile.profile_image_url_https ? profile.profile_image_url_https.replace(/_normal/, '') : null);
          collective.description = collective.description || profile.description;
          collective.backgroundImage = collective.backgroundImage || (profile.profile_banner_url ? `${profile.profile_banner_url}/1500x500` : null);
          collective.website = collective.website || profile.url;
          collective.locationName = collective.locationName || profile.location;
          collective.twitterHandle = profile.screen_name;
          collective.save();
        })
        .then(() => createConnectedAccountForCollective(req.query.CollectiveId, service))
        .then(ca => ca.update({
          username: data.profile.username,
          clientId: accessToken,
          token: data.tokenSecret,
          data: data.profile._json,
          CreatedByUserId: req.remoteUser.id
        }))
        .then(() => res.redirect(redirect || `${config.host.website}/${collective.slug}/edit#connectedAccounts`))
        .catch(next);
    }

    default:
      return next(new errors.BadRequest(`unsupported service ${service}`));
  }
};

export const verify = (req, res, next) => {
  const payload = req.jwtPayload;
  const service = req.params.service;

  if (get(paymentProviders, `${service}.oauth.verify`)) {
    return paymentProviders[service].oauth.verify(req, res, next);
  }

  if (!payload) return next(new errors.Unauthorized());
  if (payload.scope === 'connected-account' && payload.username) {
    res.send({service, username: payload.username, connectedAccountId: payload.connectedAccountId})
  } else {
    return next(new errors.BadRequest('Github authorization failed'));
  }
};

export const fetchAllRepositories = (req, res, next) => {
  const payload = req.jwtPayload;
  ConnectedAccount
  .findOne({where: {id: payload.connectedAccountId}})
  .then(ca => {

    return Promise.map([1,2,3,4,5], page => request({
      uri: 'https://api.github.com/user/repos',
      qs: {
        per_page: 100,
        sort: 'pushed',
        access_token: ca.token,
        type: 'all',
        page
      },
      headers: {
        'User-Agent': 'Open Collective',
        'Accept': 'application/vnd.github.mercy-preview+json' // needed to fetch 'topics', which we can use as tags
      },
      json: true
    }))
    .then(data => [].concat(...data))
    .filter(repo => repo.permissions && repo.permissions.push && !repo.private)
  })
  .then(body => res.json(body))
  .catch(next);
};

function createConnectedAccountForCollective(CollectiveId, service) {
  const attrs = { service };
  return models.Collective.findById(CollectiveId)
    .then(collective => attrs.CollectiveId = collective.id)
    .then(() => ConnectedAccount.findOne({ where: attrs }))
    .then(ca => ca || ConnectedAccount.create(attrs));
}
