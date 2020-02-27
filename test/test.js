var assert = require('assert'),
    cmd = require('node-cmd'),
    config = require('../config.json'),
    fs = require("fs");

/**
 * Await FixLevel Quantity Callback
 * @callback awaitFixLevelCallback
 * @param {Error}  err 
 * @param {string} fixLevel null if module is not found in table
 */

/**
* Gets module fix level
* @param {string}                 module    module to get the fix level of
* @param {awaitFixLevelCallback}  callback  function to call after completion
*
*/
function getModuleFixLevel(module, callback) {
  var command = 'zowe jobs submit data-set "' + config.remoteJclPds + '(' + config.checkVersionMember + ')" -d "job-archive/version-check" --rfj';
  
  // Submit job, await completion
  cmd.get(command, function (err, data, stderr) {
    //log output
    var content = "Error:\n" + err + "\n" + "StdErr:\n" + stderr + "\n" + "Data:\n" + data;
    writeToDir("command-archive/job-submission", content);

    if(err){
      callback(err);
    } else if (stderr){
      callback(new Error("\nCommand:\n" + command + "\n" + stderr + "Stack Trace:"));
    } else {
      data = JSON.parse(data).data;
      var retcode = data.retcode,
          jobid = data.jobid;

      //retcode should be in the form CC nnnn where nnnn is the return code
      if (retcode.split(" ")[1] <= 0) {
        //success, parse downloaded spool output
        var SYSPRINT = fs.readFileSync("./job-archive/version-check/" + jobid + "/SYSVIEW/SYSPRINT.txt", "utf-8");
        
        //First find the header
        var pattern = new RegExp(".*Name.*FixLevel.*");
        header = SYSPRINT.match(pattern);

        //Then determine the location where the FixLevel column starts
        var fixLevelLocation = header[0].indexOf("FixLevel");

        //Next, find the maintained member of interest
        pattern = new RegExp(".*____ " + module + ".*","g");
        var found = SYSPRINT.match(pattern);

        if(!found){
          callback(err, null);
        } else { //found
          //found should look like ____ Name TTR Alias-Of IdName Release Bld FixLevel AsmDate AsmTM AsmUser Owner MacLv ProdName
          //However, there may be empty entries in the row so we key off of fixLevelLocation and an ending space
          var fixLevel = found[0].substring(fixLevelLocation).split(" ")[0];
          callback(err, fixLevel);
        }
      } else {
        callback(new Error("Job did not complete successfully. Additional diagnostics:" + JSON.stringify(data,null,1)));
      }
    }
  });
}

/**
* Writes content to files
* @param {string}           dir     directory to write content to
* @param {string}           content content to write
*/
function writeToDir(dir, content) {
  var d = new Date(),
      filePath = dir + "/" + d.toISOString() + ".txt";

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  };
  
  fs.writeFileSync(filePath, content, function(err) {
    if(err) {
      return console.log(err);
    }
  });
}

describe('Maintenance', function () {
  // Change timeout to 60s from the default of 2s
  this.timeout(60000);

  /**
   * Test Plan
   * Run MODID utility to verify module is appropriately updated
   */
  describe('Module Check', function () {
    it('should have maintenance applied', function (done) {
      // Get Fix Level for maintained member specified in config
      getModuleFixLevel(config.maintainedMember, function(err, fixLevel){
        if(err){
          throw err;
        }
        assert.equal(fixLevel, config.expectedFixLevel, "Fix Level is not as expected for " + config.maintainedMember);
        done();
      });
    });
  });
});
