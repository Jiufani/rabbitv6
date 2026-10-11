'use strict';
// All /api requests reach the same Express app, including its image proxy
// and streaming graph endpoint. Do not start a port listener on Vercel.
module.exports = require('../server/index');
