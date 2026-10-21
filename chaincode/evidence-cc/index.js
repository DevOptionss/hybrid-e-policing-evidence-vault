'use strict';

const EvidenceContract = require('./lib/evidence');
const MediaContract = require('./lib/media');

module.exports.EvidenceContract = EvidenceContract;
module.exports.MediaContract = MediaContract;
module.exports.contracts = [EvidenceContract, MediaContract];
