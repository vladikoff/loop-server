/* This Source Code Form is subject to the terms of the Mozilla Public
* License, v. 2.0. If a copy of the MPL was not distributed with this
* file, You can obtain one at http://mozilla.org/MPL/2.0/. */
'use strict';
var expect = require("chai").expect;
var addHawk = require("superagent-hawk");
var supertest = addHawk(require("supertest"));
var sinon = require("sinon");
var Token = require("express-hawkauth").Token;
var request = require("request");

var loop = require("../loop");
var hmac = require("../loop/hmac");
var errors = require("../loop/errno.json");

var expectFormatedError = require("./support").expectFormatedError;

var conf = loop.conf;
var oauthConf = conf.get('fxaOAuth');
var app = loop.app;
var storage = loop.storage;

describe('/fxa-oauth', function () {

  var hawkCredentials, hawkIdHmac, sandbox;

  beforeEach(function(done) {
    sandbox = sinon.sandbox.create();

    // Generate Hawk credentials.
    var token = new Token();
    token.getCredentials(function(tokenId, authKey) {
      hawkCredentials = {
        id: tokenId,
        key: authKey,
        algorithm: "sha256"
      };
      hawkIdHmac = hmac(tokenId, conf.get('hawkIdSecret'));
      storage.setHawkSession(hawkIdHmac, authKey, function(err) {
        if (err) throw err;
        done();
      });
    });
  });

  afterEach(function() {
    sandbox.restore();
  });

  describe('GET /parameters', function() {
    it('should return the stored parameters from the config', function(done) {
      supertest(app)
        .get('/fxa-oauth/parameters')
        .hawk(hawkCredentials)
        .expect(200)
        .end(function(err, resp) {
          if (err) throw err;
          expect(resp.body.client_id).eql(oauthConf.client_id);
          expect(resp.body.oauth_uri).eql(oauthConf.oauth_uri);
          expect(resp.body.scope).eql(oauthConf.scope);
          expect(resp.body.redirect_uri).eql(oauthConf.redirect_uri);
          expect(resp.body.state).to.not.eql(undefined);
          done();
        });
    });

    it('should return the existing state if it does exist', function(done) {
      storage.setHawkOAuthState(hawkIdHmac, "1234", function(err) {
        if (err) throw err;
        supertest(app)
          .get('/fxa-oauth/parameters')
          .hawk(hawkCredentials)
          .expect(200)
          .end(function(err, resp) {
            if (err) throw err;
            expect(resp.body.state).eql("1234");
            done();
          });

      });
    });
  });

  describe('GET /token', function() {
    it('should return the stored OAuth token if there is one', function(done) {
      storage.setHawkOAuthToken(hawkIdHmac, "1234", function(err) {
        if (err) throw err;
        supertest(app)
          .get('/fxa-oauth/token')
          .hawk(hawkCredentials)
          .expect(200)
          .end(function(err, resp) {
            if (err) throw err;
            expect(resp.body.oauthToken).eql("1234");
            done();
          });
      });
    });

    it('should return an empty token if none exists yet', function(done) {
      supertest(app)
        .get('/fxa-oauth/token')
        .hawk(hawkCredentials)
        .expect(200)
        .end(function(err, resp) {
          if (err) throw err;
          expect(resp.body.oauthToken).eql(undefined);
          done();
        });
    });
  });

  describe('POST /token', function() {
    it('should error out if no state is given', function(done) {
      supertest(app)
        .post('/fxa-oauth/token?code=1234')
        .hawk(hawkCredentials)
        .expect(400)
        .end(done);
    });

    it('should error out if no code is given', function(done) {
      supertest(app)
        .post('/fxa-oauth/token?state=1234')
        .hawk(hawkCredentials)
        .expect(400)
        .end(done);
    });

    it('should error out if the state does not match', function(done) {
      storage.setHawkOAuthState(hawkIdHmac, "1234", function(err) {
        if (err) throw err;
        supertest(app)
          .post('/fxa-oauth/token?code=1234&state=5678')
          .hawk(hawkCredentials)
          .expect(400)
          .end(function(err, res) {
            if (err) throw err;
            expectFormatedError(
              res, 400, errors.INVALID_OAUTH_STATE, "Invalid OAuth state");

            storage.getHawkOAuthState(hawkIdHmac, function(err, state) {
              if (err) throw err;
              expect(state).to.eql(null);
              done();
            });
          });
      });
    });

    it('should error when request to the oauth server fails', function(done) {
      sandbox.stub(request, "post", function(options, cb) {
        cb("error");
      });

      storage.setHawkOAuthState(hawkIdHmac, "5678", function(err) {
        if (err) throw err;
        supertest(app)
          .post('/fxa-oauth/token?code=1234&state=5678')
          .hawk(hawkCredentials)
          .expect(503)
          .end(done);
      });
    });

    it('should error if the request to the profile fails', function(done) {
      sandbox.stub(request, "post", function(options, cb) {
        cb(null, null, {access_token: "token"});
      });

      sandbox.stub(request, "get", function(options, cb) {
        cb("error");
      });

      storage.setHawkOAuthState(hawkIdHmac, "5678", function(err) {
        if (err) throw err;
        supertest(app)
          .post('/fxa-oauth/token?code=1234&state=5678')
          .hawk(hawkCredentials)
          .expect(503)
          .end(done);
      });
    });

    it('should error if the returned json is invalid', function(done) {
      sandbox.stub(request, "post", function(options, cb) {
        cb(null, null, {access_token: "token"});
      });

      sandbox.stub(request, "get", function(options, cb) {
        cb(null, null, "{"); // this is invalid JSON.
      });

      storage.setHawkOAuthState(hawkIdHmac, "5678", function(err) {
        if (err) throw err;
        supertest(app)
          .post('/fxa-oauth/token?code=1234&state=5678')
          .hawk(hawkCredentials)
          .expect(503)
          .end(done);
      });
    });

    it('should return and store the oauth token', function(done) {
      sandbox.stub(request, "post", function(options, cb) {
        cb(null, null, {access_token: "token"});
      });

      sandbox.stub(request, "get", function(options, cb) {
        cb(null, null, '{"email":"alexis@mozilla.com"}');
      });

      storage.setHawkOAuthState(hawkIdHmac, "5678", function(err) {
        if (err) throw err;
        supertest(app)
          .post('/fxa-oauth/token?code=1234&state=5678')
          .hawk(hawkCredentials)
          .expect(200)
          .end(function(err, resp) {
            if (err) throw err;
            expect(resp.body.oauthToken).eql("token");
            storage.getHawkOAuthToken(hawkIdHmac, function(err, token) {
              if (err) throw err;
              expect(token).eql("token");

              // Should store the email hashed once retrieved.
              var userHmac = hmac("alexis@mozilla.com",
                                  conf.get('userMacSecret'));
              storage.getHawkUser(hawkIdHmac, function(err, retrievedData) {
                if (err) throw err;
                expect(retrievedData).eql(userHmac);
                done();
              });
            });
          });
      });
    });
  });
});
