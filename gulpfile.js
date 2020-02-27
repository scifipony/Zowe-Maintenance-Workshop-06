var cmd = require('node-cmd'),
    config = require('./config.json'),
    fs = require('fs'),
    gulp = require('gulp-help')(require('gulp')),
    gulpSequence = require('gulp-sequence'),
    PluginError = require('plugin-error'),
    readlineSync = require('readline-sync');


/**
 * await Job Callback - Callback is made without error if Job completes with 
 * CC < MaxRC in the allotted time
 * @callback awaitJobCallback
 * @param {Error}   err 
 * @param {object}  [jobResponse]
 */

 /**
 * await SSMState Callback - Callback is made without error if desired state is 
 * reached within the the allotted time
 * @callback awaitSSMStateCallback
 * @param {Error} err 
 */

  /**
  * commandObject - object contains command to submit and directory to download output to
  * @object commandObject
  * @param {string} command Command to submit
  * @param {string} dir     Directory to download command output to 
  */

/**
* Polls state of SSM managed resource. Callback is made without error if desired state is 
* reached within the the allotted time
* @param {string}                 resource     SSM managed resource to check the state of
* @param {string}                 desiredState desired state of resource
* @param {awaitSSMStateCallback}  callback     function to call after completion
* @param {number}                 tries        max attempts to check the completion of the job
* @param {number}                 wait         wait time in ms between each check
*/
function awaitSSMState(resource, desiredState, callback, tries = 30, wait = 1000) {
  if (tries > 0) {
    sleep(wait);
    cmd.get(
    'zowe ops show resource ' + resource,
    function (err, data, stderr) {
      //log output
      var content = "Error:\n" + err + "\n" + "StdErr:\n" + stderr + "\n" + "Data:\n" + data;
      writeToDir("command-archive/show-resource", content);

      if(err){
        callback(err);
      } else if (stderr){
        callback(new Error("\nCommand:\n" + command + "\n" + stderr + "Stack Trace:"));
      } else {
        //First find the header
        var pattern = new RegExp("current:.*");
        var currentState = data.match(pattern)[0].split(' ')[1];

        //check if currentState is the desiredState
        if (currentState != desiredState) {
          awaitSSMState(resource, desiredState, callback, tries - 1, wait);
        } else { //currentState does equal desiredState so success!
          callback(null);
        }
      }
    });
  } else {
      callback(new Error(resource + " did not reached desired state of " + desiredState + " in the allotted time."));
  }
}

/**
* Changes state of SSM managed resource. Callback is made without error if desired state is 
* reached within the the allotted time
* @param {string}                 resource SSM managed resource to change the state of
* @param {string}                 state    desired state of resource - UP or DOWN
* @param {awaitSSMStateCallback}  callback function to call after completion
* @param {string}                 [apf]    data set to APF authorize if required
*/
function changeResourceState(resource, state, callback, apf) {
  var command, dir;
  if(state === "UP") {
    command = 'zowe ops start resource ' + resource;
    dir = "command-archive/start-resource";
  } else if(state === "DOWN") {
    command = 'zowe ops stop resource ' + resource;
    dir = "command-archive/stop-resource";
  } else{
    callback(new Error("\nUnrecognized desired state of: " + state + ". Expected UP or DOWN."));
  }
  
  
  // Submit command, await completion
  cmd.get(command, function (err, data, stderr) {
    //log output
    var content = "Error:\n" + err + "\n" + "StdErr:\n" + stderr + "\n" + "Data:\n" + data;
    writeToDir(dir, content);

    if(err){
      callback(err);
    } else if (stderr){
      callback(new Error("\nCommand:\n" + command + "\n" + stderr + "Stack Trace:"));
    } else {
      // Await the SSM Resource Status to be up
      awaitSSMState(resource, state, function(err){
        if(err){
          callback(err);
        } else if(typeof apf !== 'undefined'){
          // Resource state successfully changed and needs APF authorized
          command = 'zowe console issue command "SETPROG APF,ADD,DSNAME=' + apf + ',SMS" --cn ' + config.consoleName;
          simpleCommand(command, callback);
        } else { //Resource state is changed, does not need APF authorized
          callback();
        }
      });
    }
  });
}

/**
* Creates zw (Zowe-Workshop) profiles for project and sets them as default
* @param {string}           host     z/OS host the project is running against
* @param {string}           user     username
* @param {string}           pass     password
* @param {awaitJobCallback} callback function to call after completion
*/
function createAndSetProfiles(host, user, pass, callback){
  var commands = [
    {
      command: "zowe profiles create zosmf zw --host " + host + " --user " + user + " --pass " +
               pass + " --port " + config.zosmfPort + " --ru " + config.zosmfRejectUnauthorized + " --ow",
      dir: "command-archive/create-zosmf-profile"
    },
    {
      command: "zowe profiles set zosmf zw",
      dir: "command-archive/set-zosmf-profile"
    },
    {
      command: "zowe profiles create fmp zw --host " + host + " --user " + user + " --pass " +
               pass + " --port " + config.fmpPort + " --ru " + config.fmpRejectUnauthorized + 
               " --protocol " + config.fmpProtocol + " --ow",
      dir: "command-archive/create-fmp-profile"
    },
    {
      command: "zowe profiles set fmp zw",
      dir: "command-archive/set-fmp-profile"
    },
    {
      command: "zowe profiles create ops zw --host " + host + " --user " + user + " --pass " +
               pass + " --port " + config.opsPort + " --ru " + config.opsRejectUnauthorized + 
               " --protocol " + config.opsProtocol + " --ow",
      dir: "command-archive/create-ops-profile"
    },
    {
      command: "zowe profiles set ops zw",
      dir: "command-archive/set-ops-profile"
    }
  ];
  submitMultipleSimpleCommands(commands, callback);
}

/**
* Parses holddata in local file and creates holddata/actions.json file with summarized findings
* @param {string}           filepath local filePath to read Holddata from
* @param {awaitJobCallback} callback function to call after completion
*/
function parseHolddata(filePath, callback){
  var actions = {
    remainingHolds: false,
    restart: false,
    reviewDoc:false
  };

  fs.readFile(filePath, {encoding: 'utf-8'}, function(err,data){
    if (!err) {
      var holds = data.split("++HOLD (" + config.expectedFixLevel + ")");
      for(var i = 1; i<holds.length; i++){
        if(holds[i].includes("REASON (DOC    )")){
          actions.reviewDoc = true;
        } else if(holds[i].includes("REASON (RESTART)")){
          actions.restart = true;
        } else {
          actions.remainingHolds = true;
        }
      }
      writeToFile("holddata", "actions.json", JSON.stringify(actions, null, 2));
    } else {
        callback(err);
    }
  });
};

/**
* Runs command and calls back without error if successful
* @param {string}           command           command to run
* @param {string}           dir               directory to log output to
* @param {awaitJobCallback} callback          function to call after completion
* @param {Array}            [expectedOutputs] array of expected strings to be in the output
*/
function simpleCommand(command, dir, callback, expectedOutputs){
  cmd.get(command, function(err, data, stderr) { 
    //log output
    var content = "Error:\n" + err + "\n" + "StdErr:\n" + stderr + "\n" + "Data:\n" + data;
    writeToDir(dir, content);
    
    if(err){
      callback(err);
    } else if (stderr){
      callback(new Error("\nCommand:\n" + command + "\n" + stderr + "Stack Trace:"));
    } else if(typeof expectedOutputs !== 'undefined'){
      verifyOutput(data, expectedOutputs, callback);
    } else {
      callback();
    }
  });
}

/**
 * Sleep function.
 * @param {number} ms Number of ms to sleep
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
* Submits job, verifies successful completion, stores output
* @param {string}           ds                  data-set to submit
* @param {string}           [dir="job-archive"] local directory to download spool to
* @param {number}           [maxRC=0]           maximum allowable return code
* @param {awaitJobCallback} callback            function to call after completion
*/
function submitJobAndDownloadOutput(ds, dir="job-archive", maxRC=0, callback){
  var command = 'zowe jobs submit data-set "' + ds + '" -d ' + dir + " --rfj";
  cmd.get(command, function(err, data, stderr) { 
    //log output
    var content = "Error:\n" + err + "\n" + "StdErr:\n" + stderr + "\n" + "Data:\n" + data;
    writeToDir("command-archive/job-submission", content);

    if(err){
      callback(err);
    } else if (stderr){
      callback(new Error("\nCommand:\n" + command + "\n" + stderr + "Stack Trace:"));
    } else {
      data = JSON.parse(data).data;
      retcode = data.retcode;

      //retcode should be in the form CC nnnn where nnnn is the return code
      if (retcode.split(" ")[1] <= maxRC) {
        callback(null,data);
      } else {
        callback(new Error("Job did not complete successfully. Additional diagnostics:" + JSON.stringify(data,null,1)));
      }
    }
  });
}

/**
* Submits multiple simple commands
* @param {commandObject[]}  commands Array of commandObjects
* @param {awaitJobCallback} callback function to call after completion
*/
function submitMultipleSimpleCommands(commands, callback){
  if(commands.length>0){
    simpleCommand(commands[0].command, commands[0].dir, function(err){
      if(err){
        callback(err);
      } else {
        commands.shift();
        submitMultipleSimpleCommands(commands, callback);
      }
    })
  } else {
    callback();
  }
}

/**
* Runs command and calls back without error if successful
* @param {string}           data            command to run
* @param {Array}            expectedOutputs array of expected strings to be in the output
* @param {awaitJobCallback} callback        function to call after completion
*/
function verifyOutput(data, expectedOutputs, callback){
  expectedOutputs.forEach(function(output){
    if (!data.includes(output)) {
      callback(new Error(output + " not found in response: " + data));
    }
  });
  // Success
  callback();
}

/**
* Writes content to files
* @param {string}           dir     directory to write content to
* @param {string}           content content to write
*/
function writeToDir(dir, content) {
  var d = new Date(),
      filename = d.toISOString() + ".txt";

  writeToFile(dir, filename, content);
}

/**
* Writes content to files
* @param {string}           dir       directory to write content to
* @param {string}           filename  filename to write content to
* @param {string}           content   content to write
*/
function writeToFile(dir, filename, content) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  };
  
  fs.writeFileSync(dir + "/" + filename, content, function(err) {
    if(err) {
      return console.log(err);
    }
  });
}

gulp.task('apf', 'APF authorize dataset', function(callback){
    var ds = config.runtimeEnv + '.' + config.maintainedPds,
        command = 'zowe console issue command "SETPROG APF,ADD,DSNAME=' + ds + ',SMS" --cn ' + config.consoleName,
        output = ["CSV410I", ds];

    simpleCommand(command, "command-archive/apf", callback, output);
});

gulp.task('apply', 'Apply Maintenance', function (callback) {
  var ds = config.remoteJclPds + '(' + config.applyMember + ')';
  submitJobAndDownloadOutput(ds, "job-archive/apply", 0, callback);
});

gulp.task('apply-check', 'Apply Check Maintenance', function (callback) {
  var ds = config.remoteJclPds + '(' + config.applyCheckMember + ')';
  submitJobAndDownloadOutput(ds, "job-archive/apply-check", 0, callback);
});

gulp.task('copy', 'Copy Maintenance to Runtime', function (callback) {
  var command = 'zowe file-master-plus copy data-set "' + config.smpeEnv + '.' + config.maintainedPds + 
                '" "' + config.runtimeEnv + '.' + config.maintainedPds + '" --rfj';
  simpleCommand(command, "command-archive/copy", callback);
});

gulp.task('download', 'Download Maintenance', function (callback) {
  var command = 'zowe files download uf "' + config.serverFolder + '/' + config.serverFile +
                '" -f "' + config.localFolder + '/' + config.localFile + '" -b --rfj';
  simpleCommand(command, "command-archive/download", callback);
});

gulp.task('receive', 'Receive Maintenance', function (callback) {
  var ds = config.remoteJclPds + '(' + config.receiveMember + ')';
  submitJobAndDownloadOutput(ds, "job-archive/receive", 0, function(err,jobResponse){
    if(err){
      callback(err);
    } else {
      parseHolddata("job-archive/receive/" + jobResponse.jobid + "/SMPEUCL/SMPRPT.txt", callback);
    }
  });
});

gulp.task('reject', 'Reject Maintenance', function (callback) {
  var ds = config.remoteJclPds + '(' + config.rejectMember + ')';
  submitJobAndDownloadOutput(ds, "job-archive/reject", 0, callback);
});

gulp.task('restartWorkflow', 'Create & trigger workflow to restart SYSVIEW', function (callback) {
  var command = 'zowe zos-workflows start workflow-full --workflow-name ' + 
                 config.restartWorkflowName + ' --wait';
  simpleCommand(command, "command-archive/start-workflow", callback);
});

gulp.task('restore', 'Restore Maintenance', function (callback) {
  var ds = config.remoteJclPds + '(' + config.restoreMember + ')';
  submitJobAndDownloadOutput(ds, "job-archive/restore", 0, callback);
});

gulp.task('setupProfiles', 'Create project profiles and set them as default', function (callback) {
  var host, user, pass;
  host = readlineSync.question('Host name or IP address: ');
  user = readlineSync.question('Username: ');
  pass = readlineSync.question('Password: ', { hideEchoBack: true });
  createAndSetProfiles(host, user, pass, callback);
});

gulp.task('start1', 'Start SSM managed resource1', function (callback) {
  changeResourceState(config.ssmResource1, "UP", callback);
});

gulp.task('start2', 'Start SSM managed resource2', function (callback) {
  changeResourceState(config.ssmResource2, "UP", callback);
});

gulp.task('stop1', 'Stop SSM managed resource1', function (callback) {
  changeResourceState(config.ssmResource1, "DOWN", callback);
});

gulp.task('stop2', 'Stop SSM managed resource2', function (callback) {
  changeResourceState(config.ssmResource2, "DOWN", callback);
});

gulp.task('upload', 'Upload Maintenance to USS', function (callback) {
  var command = 'zowe files upload ftu "' + config.localFolder + '/' + config.localFile +
                '" "' + config.remoteFolder + '/' + config.remoteFile + '" -b --rfj';
  simpleCommand(command, "command-archive/upload", callback);
});

gulp.task('reset', 'Reset maintenance level', gulpSequence('reject', 'restore', 'stop', 'copy', 'start', 'apf'));
gulp.task('start', 'Start SSM managed resources', gulpSequence('start1','start2'));
gulp.task('stop', 'Stop SSM managed resources', gulpSequence('stop2', 'stop1'));
