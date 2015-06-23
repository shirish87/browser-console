'use strict';

var fs = require('fs');
var path = require('path');
var uglify = require('uglify-js');
var debug = require('diagnostics')('bc:client');


function Client(primus) {
  this._primus = primus;
  this.clientPath = path.join(__dirname, 'public', 'client.js');
  this.dynamicPath = path.join(__dirname, 'public', 'dynamic.js');
}

Client.prototype.build = function build(callback) {
  var that = this;
  var clientPath = this.clientPath;

  fs.open(clientPath, 'r', function (err, fd) {
    if (!err || fd) {
      debug('Using existing client.js');
      return callback(err, that);
    }

    var result = uglify.minify(that._primus.library(), { fromString: true });
    if (!result || !result.code) {
      return callback(new Error('Failed to generate Primus client.'));
    }

    debug('Writing primus client.js');
    fs.writeFile(clientPath, result.code, function (err) {
      callback(err, that);
    });
  });
};

Client.prototype.export = function exportClient(tunnelUrl, callback) {
  var that = this;
  var dynamicCode = 'var primus = Primus.connect("' + tunnelUrl + '");';

  debug('Writing dynamic.js');
  fs.writeFile(this.dynamicPath, dynamicCode, function (err) {
    callback(err, that);
  });
};

module.exports = Client;
