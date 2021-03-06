//Code by: https://github.com/HerrEurobeat/ 
//If you are here, you are wrong. Open config.json and configure everything there!

//This file contains: Code for each bot instance (most of the code only affects the main bot) and handling most of the talking with Steam.

module.exports.run = async (logOnOptions, loginindex) => {
    const SteamUser = require('steam-user');
    const SteamCommunity = require('steamcommunity');
    const SteamID = require('steamid');
    const fs = require("fs");
    const xml2js = require('xml2js');
    const https = require('https')

    var updater = require('./updater.js');
    var controller = require("./controller.js");
    var config = require('../config.json');
    var extdata = require('./data.json');
    var cachefile = require('./cache.json');

    var enabledebugmode = false; //if enabled debug and debug-verbose events from the steam-user library will be logged (will absolutely spam your output.txt file!)
    var disablecommentcmd = false; //disables the comment and resetcooldown command and responds with maintenance message 

    var commandcooldown = 12000 //The bot won't respond if a user sends more than 5 messages in this time frame
    var maxLogOnRetries = 1 //How often a failed logOn will be retried
    var lastWebSessionRefresh = Date.now(); //Track when the last refresh was to avoid spamming webLogOn() on sessionExpired
    var logger = controller.logger
    var lang = controller.lang
    var commentedrecently = 0; //global cooldown for the comment command
    var commentcounter = 0; //this will count the total of comments requested since the last reboot
    var lastmessage = {}
    var lastcommentrequestmsg = []
    var failedcomments = []
    var activecommentprocess = []

    var abortunfriendall;
    var abortleaveallgroups;

    if (loginindex == 0) var thisbot = "Main"
        else var thisbot = `Bot ${loginindex}`

    //Get proxy of this bot account
    if (controller.proxyShift >= controller.proxies.length) controller.proxyShift = 0; //reset proxy counter
    var thisproxy = controller.proxies[controller.proxyShift]
    controller.proxyShift++ //switch to next proxy

    const bot = new SteamUser({ autoRelogin: false, httpProxy: thisproxy });
    const community = new SteamCommunity();

    if (enabledebugmode) {
        bot.on("debug", (msg) => {
            logger(`[${thisbot}] debug: ${msg}`, false, true)
        })

        bot.on("debug-verbose", (msg) => {
            logger(`[${thisbot}] debug-verbose: ${msg}`, false, true)
        })
    }

    //Make chat message method shorter
    function chatmsg(steamID, txt) {
        bot.chat.sendFriendMessage(steamID, txt)
    }

    //Function to return last successful comment from lastcomment.json
    function lastsuccessfulcomment(callback) {
        var greatesttimevalue = 0

        controller.lastcomment.find({}, (err, docs) => { //get all documents
            docs.forEach((e, i) => {
                if (e.time > greatesttimevalue) greatesttimevalue = Number(e.time)

                if (i == docs.length - 1) {
                    return callback(greatesttimevalue) }
            })
        }) 
    }

    //Group stuff
    if (loginindex == 0) { //group64id only needed by main bot -> remove unnecessary load from other bots
        var configgroup64id = ""
        var yourgroupoutput = ""

        if (cachefile.configgroup == config.yourgroup) { //id is stored in cache file, no need to get it again
            logger(`group64id of yourgroup is stored in cache.json...`, false, true)
            configgroup64id = cachefile.configgroup64id
        } else {
            logger(`group64id of yourgroup not in cache.json...`, false, true)
        
            if (config.yourgroup.length < 1) {
                logger('Skipping group64id request of yourgroup because config.yourgroup is empty.', false, true); //log to output for debugging

            } else {

                logger(`Getting group64id of yourgroup...`, false, true)
                https.get(`${config.yourgroup}/memberslistxml/?xml=1`, function(yourgroupres) { //get group64id from code to simplify config
                    yourgroupres.on('data', function (chunk) {
                        yourgroupoutput += chunk });

                    yourgroupres.on('end', () => {
                        if (!String(yourgroupoutput).includes("<?xml") || !String(yourgroupoutput).includes("<groupID64>")) { //Check if botsgroupoutput is steam group xml data before parsing it
                            logger("\x1b[0m[\x1b[31mNotice\x1b[0m] Your group (yourgroup in config) doesn't seem to be valid!", true); 
                        } else {
                            new xml2js.Parser().parseString(yourgroupoutput, function(err, yourgroupResult) {
                                if (err) return logger("error parsing yourgroup xml: " + err, true)

                                configgroup64id = yourgroupResult.memberList.groupID64

                                cachefile.configgroup = config.yourgroup
                                cachefile.configgroup64id = String(yourgroupResult.memberList.groupID64)
                                fs.writeFile("./src/cache.json", JSON.stringify(cachefile, null, 4), err => { 
                                    if (err) logger(`[${thisbot}] error writing configgroup64id to cache.json: ${err}`) 
                            })
                        }) 
                    } 
                })
                
                }).on("error", function(err) { 
                    logger("\x1b[0m[\x1b[31mNotice\x1b[0m]: Couldn't get yourgroup 64id. Either Steam is down or your internet isn't working.\n          Error: " + err, true)
                }) 
            } 
        } 
    }

    //Comment command (outside of friendMessage Event to be able to call it from controller.js)
    var commentcmd = undefined //this is just here to make eslint happy so that the export in loggedOn is not undefined

    if (loginindex == 0) {
        /**
         * The comment command
         * @param {Object} steamID steamID of message author
         * @param {Array<String>} args An array containing all arguments provided in the message by the user
         * @param {Object} res An express response object that will be available if the function is called from the express webserver
         */
        commentcmd = (steamID, args, res) => {
            var steam64id = new SteamID(String(steamID)).getSteamID64()

            controller.lastcomment.findOne({ id: steam64id }, (err, lastcommentdoc) => {
                if (!lastcommentdoc) logger("User is missing from database?? How is this possible?! Error maybe: " + err)

                try { //catch any unhandled error to be able to remove user from activecommentprocess array
                    require("./comment.js").run(logger, chatmsg, lang, community, thisbot, steamID, args, res, lastcommentdoc, failedcomments, activecommentprocess, lastcommentrequestmsg, commentedrecently, commentcounter, lastsuccessfulcomment, (fc, acp, cr, cc) => { //callback transports stuff back to be able to store the stuff here
                        failedcomments = fc //update failedcomments
                        activecommentprocess = acp
                        module.exports.activecommentprocess = acp //update exported value so that updater knows whats up
                        commentedrecently = cr
                        commentcounter = cc
                    })
                } catch (err) {
                    activecommentprocess = activecommentprocess.filter(item => item != steam64id) //Remove user from array to make sure you can't get stuck in there (not perfect as this won't trigger when the error occurrs in a nested function)
                    logger("Error while processing comment request: " + err)
                }
            })
        }
    }

    /* ------------ Login & Events: ------------ */ 
    let logOnTries = 0;

    function logOnAccount() {
        var loggedininterval = setInterval(() => { //set an interval to check if previous acc is logged on
            if (controller.accisloggedin || logOnTries > 0) { //start attempt if previous account is logged on or if this call is a retry
                logOnTries++
                clearInterval(loggedininterval) //stop interval
                controller.accisloggedin = false; //set to false again

                if (thisproxy == null) logger(`[${thisbot}] Trying to log in without proxy... (Attempt ${logOnTries}/${maxLogOnRetries + 1})`, false, true)
                    else logger(`[${thisbot}] Trying to log in with proxy ${controller.proxyShift - 1}... (Attempt ${logOnTries}/${maxLogOnRetries + 1})`, false, true)
                
                bot.logOn(logOnOptions)
            }
        }, 250) 
    }

    function relogAccount() { //Function to regulate automatic relogging and delay it to 
        if (!controller.relogQueue.includes(loginindex)) {
            controller.relogQueue.push(loginindex)
            logOnTries = 0;
            logger(`[${thisbot}] Queueing for a relog. ${controller.relogQueue.length - 1} other accounts are waiting...`, false, true)
        }

        var relogInterval = setInterval(() => {
            if (controller.relogQueue.indexOf(loginindex) != 0) return; //not our turn? stop and retry in the next iteration

            clearInterval(relogInterval) //prevent any retries
            bot.logOff()

            logger(`[${thisbot}] It is now my turn. Waiting ${controller.relogdelay / 1000} seconds before attempting to relog...`, false, true)
            setTimeout(() => {
                if (thisproxy == null) logger(`[${thisbot}] Trying to relog without proxy...`, false, true)
                    else logger(`[${thisbot}] Trying to relog with proxy ${controller.proxyShift - 1}...`, false, true)
                
                bot.logOn(logOnOptions)
            }, controller.relogdelay);
        }, 1000);
    }
  
    logOnAccount();

    bot.on('error', (err) => { //Handle errors that were caused during logOn
        if (err.eresult == 34) {
            logger(`\x1b[31m[${thisbot}] Lost connection to Steam. Reason: LogonSessionReplaced\x1b[0m`)
            if (loginindex == 0) { logger(`\x1b[31mAccount is bot0. Aborting...\x1b[0m`, true); process.exit(0) }
            return; 
        }

        //Check if this is a connection loss and not a login error (because disconnects will be thrown here when autoRelogin is false)
        if (Object.keys(controller.botobject).includes(String(loginindex)) && !controller.relogQueue.includes(loginindex)) { //it must be a disconnect when the bot was once logged in and is not yet in the queue
            logger(`\x1b[31m[${thisbot}] Lost connection to Steam. Reason: ${err}\x1b[0m`)

            if (controller.relogAfterDisconnect && !controller.skippednow.includes(loginindex)) { 
                logger(`\x1b[32m[${thisbot}] Initiating a relog in 30 seconds.\x1b[0m`) //Announce relog
                setTimeout(() => {
                    relogAccount()
                }, 30000);
            } else {
                logger(`[${thisbot}] I won't queue myself for a relog because this account was skipped or this is an intended logOff.`)
            }
        } else {
            //Actual error durin login or relog:
            let blockedEnumsForRetries = [5, 12, 13, 17, 18] //Enums: https://github.com/DoctorMcKay/node-steam-user/blob/master/enums/EResult.js

            if ((logOnTries > maxLogOnRetries && !controller.relogQueue.includes(loginindex)) || blockedEnumsForRetries.includes(err.eresult)) { //check if this is an initial login error and it is either a fatal error or all retries are used
                logger(`\nCouldn't log in bot${loginindex} after ${logOnTries} attempt(s). ${err} (${err.eresult})`, true)

                //Add additional messages for specific errors to hopefully help the user diagnose the cause
                if (err.eresult == 5) logger(`Note: The error "InvalidPassword" (${err.eresult}) can also be caused by a wrong Username or shared_secret!\n      Try leaving the shared_secret field empty and check the username & password of bot${loginindex}.`, true)
                if (thisproxy != null) logger(`Is your proxy ${controller.proxyShift} offline or blocked by Steam?`, true)

                if (loginindex == 0) {
                    logger("\nAborting because the first bot account always needs to be logged in!\nPlease correct what caused the error and try again.", true)
                    process.exit(0)
                } else {
                    logger(`Failed account is not bot0. Skipping account...`, true)
                    controller.accisloggedin = true; //set to true to log next account in

                    updater.skippedaccounts.push(loginindex)
                    controller.skippednow.push(loginindex) 
                }
            } else {
                //Got retries left or it is a relog...
                logger(`${err} (${err.eresult}) while trying to log in bot${loginindex}. Retrying in 5 seconds...`)

                setTimeout(() => {
                    //Call either relogAccount or logOnAccount function to continue where we started at
                    if (controller.relogQueue.includes(loginindex)) relogAccount();
                        else logOnAccount();
                }, 5000)
            }
        }
    })

    bot.on('steamGuard', function(domain, callback, lastCodeWrong) { //fired when steamGuard code is requested when trying to log in
        function askforcode() { //function to handle code input, manual skipping with empty input and automatic skipping with skipSteamGuard 
            logger(`[${thisbot}] Steam Guard code requested...`, false, true)
            logger('Code Input', true, true) //extra line with info for output.txt because otherwise the text from above get's halfway stuck in the steamGuard input field

            var steamGuardInputStart = Date.now(); //measure time to subtract it later from readyafter time

            if (loginindex == 0) process.stdout.write(`[${logOnOptions.accountName}] Steam Guard Code: `)
                else process.stdout.write(`[${logOnOptions.accountName}] Steam Guard Code (leave empty and press ENTER to skip account): `)

            var stdin = process.openStdin(); //start reading input in terminal

            stdin.resume()
            stdin.addListener('data', text => { //fired when input was submitted
                var code = text.toString().trim()
                stdin.pause() //stop reading
                stdin.removeAllListeners('data')

                if (code == "") { //manual skip initated
                    if (loginindex == 0) { //first account can't be skipped
                        logger("The first account always has to be logged in!", true)

                        setTimeout(() => {
                            askforcode(); //run function again
                        }, 500);
                    } else {
                        logger(`[${thisbot}] steamGuard input empty, skipping account...`, false, true)
                        controller.accisloggedin = true; //set to true to log next account in
                        updater.skippedaccounts.push(loginindex)
                        controller.skippednow.push(loginindex) 

                        bot.logOff() //Seems to prevent the steamGuard lastCodeWrong check from requesting again every few seconds
                    }

                } else { //code provided
                    logger(`[${thisbot}] Accepting steamGuard code...`, false, true)
                    callback(code) //give code back to node-steam-user
                }

                controller.steamGuardInputTimeFunc(Date.now() - steamGuardInputStart) //measure time and subtract it from readyafter time
            })
        } //function end

        //check if skipSteamGuard is on so we don't need to prompt the user for a code
        if (config.skipSteamGuard) {
            if (loginindex > 0) {
                logger(`[${thisbot}] Skipping account because skipSteamGuard is enabled...`, false, true)
                controller.accisloggedin = true; //set to true to log next account in
                updater.skippedaccounts.push(loginindex)
                controller.skippednow.push(loginindex)

                bot.logOff() //Seems to prevent the steamGuard lastCodeWrong check from requesting again every few seconds
                return;
            } else {
                logger("Even with skipSteamGuard enabled, the first account always has to be logged in.", true)
            } 
        }

        //calling the function:
        if (lastCodeWrong && !controller.skippednow.includes(loginindex)) { //last submitted code seems to be wrong and the loginindex wasn't already skipped (just to make sure)
            logger('', true, true)
            logger('Your code seems to be wrong, please try again!', true)

            setTimeout(() => {
                askforcode(); //code seems to be wrong! ask again...
            }, 500);
        } else {
            askforcode(); //ask first time
        }
    });

    bot.on('loggedOn', () => { //this account is now logged on
        logger(`[${thisbot}] Account logged in! Waiting for websession...`, false, true)
        bot.setPersona(1); //set online status

        if (loginindex == 0) bot.gamesPlayed(config.playinggames); //set game only for the main bot
        if (loginindex != 0) bot.gamesPlayed(config.childaccplayinggames) //set games for child accounts that are set in the config

        //Check if all friends are in lastcomment database
        if (loginindex == 0) {
            controller.lastcomment.find({}, (err, docs) => {
                Object.keys(bot.myFriends).forEach(e => {

                    if (bot.myFriends[e] == 3 && !docs.find(el => el.id == e)) {
                        let lastcommentobj = {
                            id: e,
                            time: Date.now() - (config.commentcooldown * 60000) //subtract commentcooldown so that the user is able to use the command instantly
                        }

                        controller.lastcomment.insert(lastcommentobj, (err) => { if (err) logger("Error inserting existing user into lastcomment.db database! Error: " + err) })
                    }
                })
            })
        }
        

        //If the loginindex is already included then this is a restart
        controller.communityobject[loginindex] = community //export this community instance to the communityobject to access it from controller.js
        controller.botobject[loginindex] = bot //export this bot instance to the botobject to access it from controller.js

        if (loginindex == 0 && !Object.keys(controller.botobject[0]).includes(commentcmd)) {
            Object.keys(controller.botobject[0]).push(commentcmd)
            controller.botobject[0].commentcmd = commentcmd 
        }
    });

    bot.on("webSession", (sessionID, cookies) => { //get websession (log in to chat)
        community.setCookies(cookies); //set cookies (otherwise the bot is unable to comment)

        if (loginindex == 0) controller.botobject[0]["configgroup64id"] = configgroup64id //export configgroup64id to access it from controller.js when botsgroup == yourgroup
        controller.accisloggedin = true; //set to true to log next account in

        //Accept offline group & friend invites
        logger(`[${thisbot}] Got websession and set cookies.`, false, true)

        //If this is a relog then remove this account from the queue and let the next account be able to relog
        if (controller.relogQueue.includes(loginindex)) {
            logger(`[${thisbot}] Relog successful.`)
            controller.relogQueue.splice(controller.relogQueue.indexOf(loginindex), 1) //remove this loginindex from the queue
        }

        logger(`[${thisbot}] Accepting offline friend & group invites...`, false, true)

        //Friends:
        for (let i = 0; i < Object.keys(bot.myFriends).length; i++) { //Credit: https://dev.doctormckay.com/topic/1694-accept-friend-request-sent-in-offline/  
            if (bot.myFriends[Object.keys(bot.myFriends)[i]] == 2) {
                bot.addFriend(Object.keys(bot.myFriends)[i]); //accept friend request
                logger(`[${thisbot}] Added user while I was offline! User: ` + Object.keys(bot.myFriends)[i])
                chatmsg(String(Object.keys(bot.myFriends)[i]), lang.useradded) //send welcome message

                //Add user to lastcomment database
                let lastcommentobj = {
                    id: Object.keys(bot.myFriends)[i],
                    time: Date.now() - (config.commentcooldown * 60000) //subtract commentcooldown so that the user is able to use the command instantly
                }

                controller.lastcomment.remove({ id: Object.keys(bot.myFriends)[i] }, {}, (err) => { if (err) logger("Error removing duplicate steamid from lastcomment.db on offline friend accept! Error: " + err) }) //remove any old entries
                controller.lastcomment.insert(lastcommentobj, (err) => { if (err) logger("Error inserting new user into lastcomment.db database! Error: " + err) })

                if (configgroup64id && configgroup64id.length > 1 && Object.keys(bot.myGroups).includes(configgroup64id)) { 
                    bot.inviteToGroup(Object.keys(bot.myFriends)[i], new SteamID(configgroup64id));

                    if (configgroup64id !== "103582791464712227") { //https://steamcommunity.com/groups/3urobeatGroup
                        bot.inviteToGroup(Object.keys(bot.myFriends)[i], new SteamID("103582791464712227")); //invite the user to your group
                    }
                }
            } 
        }

        //Groups:
        for (let i = 0; i < Object.keys(bot.myGroups).length; i++) {
            if (bot.myGroups[Object.keys(bot.myGroups)[i]] == 2) {
                if (config.acceptgroupinvites !== true) { //check if group accept is false
                    if (config.botsgroup.length < 1) return; 
                    if (Object.keys(bot.myGroups)[i] !== config.botsgroup) { return; } //check if group id is bot group
                }

                bot.respondToGroupInvite(Object.keys(bot.myGroups)[i], true)
                logger(`[${thisbot}] Accepted group invite while I was offline: ` + Object.keys(bot.myGroups)[i])
            }
        }

        if(controller.checkm8!="b754jfJNgZWGnzogvl<rsHGTR4e368essegs9<"){process.exit(0)}
    });

    //Accept Friend & Group requests/invites
    bot.on('friendRelationship', (steamID, relationship) => {
        if (relationship === 2) {
            bot.addFriend(steamID); //accept friend request
            logger(`[${thisbot}] Added User: ` + new SteamID(String(steamID)).getSteamID64())

            if (loginindex === 0) {
                chatmsg(steamID, lang.useradded) 
            }

            if (loginindex == 0 && configgroup64id.length > 1 && Object.keys(bot.myGroups).includes(configgroup64id)) { 
                bot.inviteToGroup(steamID, new SteamID(configgroup64id)); //invite the user to your group
                
                if (configgroup64id != "103582791464712227") { //https://steamcommunity.com/groups/3urobeatGroup
                    bot.inviteToGroup(steamID, new SteamID("103582791464712227")); 
                } 
            }


            let lastcommentobj = {
                id: new SteamID(String(steamID)).getSteamID64(),
                time: Date.now() - (config.commentcooldown * 60000) //subtract commentcooldown so that the user is able to use the command instantly
            }

            controller.lastcomment.remove({ id: new SteamID(String(steamID)).getSteamID64() }, {}, (err) => { if (err) logger("Error removing duplicate steamid from lastcomment.db on friendRelationship! Error: " + err) }) //remove any old entries
            controller.lastcomment.insert(lastcommentobj, (err) => { if (err) logger("Error inserting new user into lastcomment.db database! Error: " + err) })

            controller.friendlistcapacitycheck(loginindex); //check remaining friendlist space
        }
    });

    bot.on('groupRelationship', (steamID, relationship) => {
        if (relationship === 2 && config.acceptgroupinvites) { //accept invite if acceptgroupinvites is true
            bot.respondToGroupInvite(steamID, true)
            logger(`[${thisbot}] Accepted group invite: ` + new SteamID(String(steamID)).getSteamID64())
        }
    });


    /* ------------ Message interactions: ------------ */
    bot.on('friendMessage', function(steamID, message) {
        var steam64id = new SteamID(String(steamID)).getSteamID64()
        var ownercheck = config.ownerid.includes(steam64id)
        if (bot.myFriends[steam64id] == 1 || bot.myFriends[steam64id] == 6) return; //User is blocked.

        //Spam "protection" because spamming the bot is bad!
        if (!lastmessage[steam64id] || lastmessage[steam64id][0] + commandcooldown < Date.now()) lastmessage[steam64id] = [Date.now(), 0] //Add user to array or Reset time
        if (lastmessage[steam64id] && lastmessage[steam64id][0] + commandcooldown > Date.now() && lastmessage[steam64id][1] > 5) return; //Just don't respond

        if (lastmessage[steam64id] && lastmessage[steam64id][0] + commandcooldown > Date.now() && lastmessage[steam64id][1] > 4) { //Inform the user about the cooldown
            chatmsg(steamID, lang.userspamblock)
            logger(`${steam64id} has been blocked for 60 seconds for spamming.`)
            lastmessage[steam64id][0] += 60000
            lastmessage[steam64id][1]++
            return; 
        }

        if (!ownercheck) lastmessage[steam64id][1]++ //push new message to array if user isn't an owner

        //log friend message but cut it if it is >= 75 chars
        if (message.length >= 75) logger(`[${thisbot}] Friend message from ${steam64id}: ${message.slice(0, 75) + "..."}`);
            else logger(`[${thisbot}] Friend message from ${steam64id}: ${message}`);
            
        //Deny non-friends the use of any command
        if (bot.myFriends[steam64id] != 3) return chatmsg(steamID, lang.usernotfriend)

        if (loginindex === 0) { //check if this is the main bot
            //Check if bot is not fully started yet and block cmd usage if that is the case to prevent errors
            if (controller.readyafter == 0) return chatmsg(steamID, lang.botnotready)
            if (controller.relogQueue.length > 0) return chatmsg(steamID, lang.botnotready)

            var lastcommentsteamID = steam64id
            var notownerresponse = (() => { return chatmsg(steamID, lang.commandowneronly) })

            //Check if user is in lastcomment database
            controller.lastcomment.findOne({ id: steam64id }, (err, doc) => {
                if (err) logger("Database error on friendMessage. This is weird. Error: " + err)

                if (!doc) { //add user to database if he/she is missing for some reason
                    let lastcommentobj = {
                        id: new SteamID(String(steamID)).getSteamID64(),
                        time: Date.now() - (config.commentcooldown * 60000) //subtract commentcooldown so that the user is able to use the command instantly
                    }
                    
                    controller.lastcomment.insert(lastcommentobj, (err) => { if (err) logger("Error inserting new user into lastcomment.db database! Error: " + err) }) 
                }
            })

            var cont = message.slice("!").split(" ");
            var args = cont.slice(1); 

            switch(cont[0].toLowerCase()) {
                case '!h':
                case 'help':
                case '!help':
                case '!commands':
                    if (ownercheck) {
                        if (Object.keys(controller.communityobject).length > 1 || config.maxOwnerComments) var commenttext = `'!comment (amount/"all") [profileid] [custom, quotes]' - ${lang.helpcommentowner1.replace("maxOwnerComments", config.maxOwnerComments)}`
                            else var commenttext = `'!comment ("1") [profileid] [custom, quotes]' - ${lang.helpcommentowner2}`
                    } else {
                        if (Object.keys(controller.communityobject).length > 1 || config.maxComments) var commenttext = `'!comment (amount/"all")' - ${lang.helpcommentuser1.replace("maxComments", config.maxComments)}`
                            else var commenttext = `'!comment' - ${lang.helpcommentuser2}` 
                    }

                    if (config.yourgroup.length > 1) var yourgrouptext = lang.helpjoingroup;
                        else var yourgrouptext = "";

                    chatmsg(steamID, `${extdata.mestr}'s Comment Bot | ${lang.helpcommandlist}\n
                        ${commenttext}\n
                        '!ping' - ${lang.helpping}
                        '!info' - ${lang.helpinfo}
                        '!abort' - ${lang.helpabort}
                        '!about' - ${lang.helpabout}
                        '!owner' - ${lang.helpowner}
                        ${yourgrouptext}

                        ${lang.helpreadothercmdshere} ' https://github.com/HerrEurobeat/steam-comment-service-bot/wiki/Commands-documentation '`)
                    break;
                
                case '!comment':
                    if (disablecommentcmd) return chatmsg(steamID, lang.botmaintenance)

                    commentcmd(steamID, args) //Just call the function like normal when the command was used
                    break;
                
                case '!ping':
                    var pingstart = Date.now()

                    https.get(`https://steamcommunity.com/ping`, function(res) { //ping steamcommunity.com/ping and measure time
                        res.setEncoding('utf8');
                        res.on('data', () => {}) //seems like this is needed to be able to catch 'end' but since we don't need to collect anything this stays empty

                        res.on('end', () => {
                            chatmsg(steamID, lang.pingcmdmessage.replace("pingtime", Date.now() - pingstart))
                        })
                    })
                    break;
                
                case '!info':
                    controller.lastcomment.findOne({ id: steam64id }, (err, doc) => {
                        lastsuccessfulcomment(cb => {
                            /* eslint-disable no-irregular-whitespace */
                            chatmsg(steamID, `
                                -----------------------------------~~~~~------------------------------------ 
                                >   ${extdata.mestr}'s Comment Bot [Version ${extdata.versionstr}] (More info: !about)
                                >   Uptime: ${Number(Math.round(((new Date() - controller.bootstart) / 3600000)+'e'+2)+'e-'+2)} hours | Branch: ${extdata.branch}
                                >   'node.js' Version: ${process.version} | RAM Usage (RSS): ${Math.round(process.memoryUsage()["rss"] / 1024 / 1024 * 100) / 100} MB
                                >   Accounts: ${Object.keys(controller.communityobject).length} | maxComments/owner: ${config.maxComments}/${config.maxOwnerComments} | delay: ${config.commentdelay}
                                |
                                >   Your steam64ID: ${steam64id}
                                >   Your last comment request: ${(new Date(doc.time)).toISOString().replace(/T/, ' ').replace(/\..+/, '')} (GMT time)
                                >   Last processed comment request: ${(new Date(cb)).toISOString().replace(/T/, ' ').replace(/\..+/, '')} (GMT time)
                                >   I have commented ${commentcounter} times since my last restart and completed request!
                                -----------------------------------~~~~~------------------------------------
                            `) 
                            /* eslint-enable no-irregular-whitespace */
                        })
                    })
                    break;
                
                case '!owner':
                    if (config.owner.length < 1) return chatmsg(steamID, lang.ownercmdnolink)

                    chatmsg(steamID, lang.ownercmdmsg + "\n" + config.owner)
                    break;
                
                case '!group':
                    if (config.yourgroup.length < 1 || configgroup64id.length < 1) return chatmsg(steamID, lang.groupcmdnolink) //no group info at all? stop.
                    if (configgroup64id.length > 1 && Object.keys(bot.myGroups).includes(configgroup64id)) { 
                        bot.inviteToGroup(steamID, configgroup64id); chatmsg(steamID, lang.groupcmdinvitesent); 
                        
                        if (configgroup64id != "103582791464712227") { //https://steamcommunity.com/groups/3urobeatGroup
                        bot.inviteToGroup(steamID, new SteamID("103582791464712227")); } 
                        return; } //id? send invite and stop

                    chatmsg(steamID, lang.groupcmdinvitelink + config.yourgroup) //seems like no id has been saved but an url. Send the user the url
                    break;
                
                case '!abort':
                    if (!activecommentprocess.includes(steam64id)) return chatmsg(steamID, lang.abortcmdnoprocess)

                    var index = activecommentprocess.indexOf(steam64id) //get index of this steam64id
                    activecommentprocess.splice(index, 1)

                    logger(`Aborting ${steam64id}'s comment process...`)
                    chatmsg(steamID, lang.abortcmdsuccess)
                    break;
                
                case '!rc':
                case '!resetcooldown':
                    if (!ownercheck) return notownerresponse();
                    if (disablecommentcmd) return chatmsg(steamID, lang.botmaintenance)

                    if (config.commentcooldown === 0) return chatmsg(steamID, lang.resetcooldowncmdcooldowndisabled) //is the cooldown enabled?

                    if (args[0]) {
                        if (args[0] == "global") { //Check if user wants to reset the global cooldown
                            commentedrecently = 0
                            return chatmsg(steamID, lang.resetcooldowncmdglobalreset) 
                        }

                        if (isNaN(args[0])) return chatmsg(steamID, lang.invalidprofileid) 
                        if (new SteamID(args[0]).isValid() === false) return chatmsg(steamID, lang.invalidprofileid) 
                        var lastcommentsteamID = args[0] 
                    }

                    controller.lastcomment.update({ id: lastcommentsteamID }, { $set: { time: Date.now() - (config.commentcooldown * 60000) } }, (err) => { 
                        if (err) return chatmsg(steamID, "Error updating database entry: " + err)
                        else chatmsg(steamID, lang.resetcooldowncmdsuccess.replace("profileid", lastcommentsteamID.toString())) 
                    })
                    break;
                
                case '!config':
                case '!settings':
                    if (!ownercheck) return notownerresponse();
            
                    if (!args[0]) { 
                        fs.readFile('./config.json', function(err, data) { //Use readFile to get an unprocessed object
                            if (err) return chatmsg(steamID, lang.settingscmdfailedread + err)
                            chatmsg(steamID, lang.settingscmdcurrentsettings + "\n" + data.toString().slice(1, -1)) //remove first and last character which are brackets
                        })
                        return; 
                    }

                    if (!args[1]) return chatmsg(steamID, "Please provide a new value for the key you want to change!")

                    //Block those 3 values to don't allow another owner to take over ownership
                    if (args[0] == "enableevalcmd" || args[0] == "ownerid" || args[0] == "owner") {
                        return chatmsg(steamID, lang.settingscmdblockedvalues) 
                    }

                    var keyvalue = config[args[0]] //save old value to be able to reset changes

                    //I'm not proud of this code but whatever -> used to convert array into usable array
                    if (Array.isArray(keyvalue)) {
                        let newarr = []

                        args.forEach((e, i) => {
                            if (i == 0) return; //skip args[0]
                            if (i == 1) e = e.slice(1) //remove first char which is a [
                            if (i == args.length - 1) e = e.slice(0, -1) //remove last char which is a ]

                            e = e.replace(/,/g, "") //Remove ,
                            if (e.startsWith('"')) newarr[i - 1] = String(e.replace(/"/g, ""))
                                else newarr[i - 1] = Number(e) 
                        })

                        args[1] = newarr
                    }

                    //Convert to number or boolean as input is always a String
                    if (typeof(keyvalue) == "number") args[1] = Number(args[1])
                    if (typeof(keyvalue) == "boolean") { //prepare for stupid code because doing Boolean(value) will always return true
                        if (args[1] == "true") args[1] = true
                        if (args[1] == "false") args[1] = false //could have been worse tbh
                    }

                    //round maxComments value in order to avoid the possibility of weird amounts
                    if (args[0] == "maxComments" || args[0] == "maxOwnerComments") args[1] = Math.round(args[1])

                    if (keyvalue == undefined) return chatmsg(steamID, lang.settingscmdkeynotfound)
                    if (keyvalue == args[1]) return chatmsg(steamID, lang.settingscmdsamevalue.replace("value", args[1]))

                    config[args[0]] = args[1] //apply changes

                    //32-bit integer limit check from controller.js's startup checks
                    if (typeof(keyvalue) == "number" && config.commentdelay * config.maxComments > 2147483647 || typeof(keyvalue) == "number" && config.commentdelay * config.maxOwnerComments > 2147483647) { //check this here after the key has been set and reset the changes if it should be true
                        config[args[0]] = keyvalue
                        return chatmsg(steamID, lang.settingscmdvaluetoobig) //Just using the check from controller.js
                    }

                    chatmsg(steamID, lang.settingscmdvaluechanged.replace("targetkey", args[0]).replace("oldvalue", keyvalue).replace("newvalue", args[1]))
                    logger(`${args[0]} has been changed from ${keyvalue} to ${args[1]}.`)

                    if (args[0] == "playinggames") {
                        logger("Refreshing game status of all bot accounts...")
                        Object.keys(controller.botobject).forEach((e, i) => {
                            if (loginindex == 0) controller.botobject[i].gamesPlayed(config.playinggames); //set game only for the main bot
                            if (loginindex != 0 && config.childaccsplaygames) controller.botobject[i].gamesPlayed(config.playinggames.slice(1, config.playinggames.length)) //play game with child bots but remove the custom game
                        }) 
                    }

                    //Get arrays on one line
                    var stringifiedconfig = JSON.stringify(config,function(k,v) { //Credit: https://stackoverflow.com/a/46217335/12934162
                        if(v instanceof Array)
                        return JSON.stringify(v);
                        return v; 
                    }, 4)
                        .replace(/"\[/g, '[')
                        .replace(/\]"/g, ']')
                        .replace(/\\"/g, '"')
                        .replace(/""/g, '""');

                    fs.writeFile("./config.json", stringifiedconfig, err => {
                        if (err) return logger(`write settings cmd changes to config error: ${err}`)
                    
                        delete require.cache[require.resolve("../config")]
                        config = require("../config.json")
                    })
                    break;
                
                case '!failed':
                    controller.lastcomment.findOne({ id: steam64id }, (err, doc) => {
                        if (!failedcomments[steam64id] || Object.keys(failedcomments[steam64id]).length < 1) return chatmsg(steamID, lang.failedcmdnothingfound);
                        chatmsg(steamID, lang.failedcmdmsg.replace("steam64id", steam64id).replace("requesttime", new Date(doc.time).toISOString().replace(/T/, ' ').replace(/\..+/, '')) + "\n\n" + JSON.stringify(failedcomments[steam64id], null, 4))
                    })
                    break;
                
                case '!about': //Please don't change this message as it gives credit to me; the person who put really much of his free time into this project. The bot will still refer to you - the operator of this instance.
                    chatmsg(steamID, controller.aboutstr)
                    break;
                
                case '!addfriend':
                    if (!ownercheck) return notownerresponse();
                    if (isNaN(args[0])) return chatmsg(steamID, lang.invalidprofileid)
                    if (new SteamID(args[0]).isValid() === false) return chatmsg(steamID, lang.invalidprofileid)

                    //Check if first bot account is limited to be able to display error message instantly
                    if (controller.botobject[0].limitations && controller.botobject[0].limitations.limited == true) {
                        chatmsg(steamID, lang.addfriendcmdacclimited.replace("profileid", args[0])) 
                        return; 
                    }

                    chatmsg(steamID, lang.addfriendcmdsuccess.replace("profileid", args[0]).replace("estimatedtime", 5 * Object.keys(controller.botobject).length))
                    logger(`Adding friend ${args[0]} with all bot accounts... This will take ~${5 * Object.keys(controller.botobject).length} seconds.`)

                    Object.keys(controller.botobject).forEach((i) => {
                        //Check if this bot account is limited
                        if (controller.botobject[i].limitations && controller.botobject[i].limitations.limited == true) {
                            logger(`Can't add friend ${args[0]} with bot${i} because the bot account is limited.`) 
                            return;
                        }

                        if (controller.botobject[i].myFriends[new SteamID(args[0])] != 3 && controller.botobject[i].myFriends[new SteamID(args[0])] != 1) { //check if provided user is not friend and not blocked
                            setTimeout(() => {
                                controller.communityobject[i].addFriend(new SteamID(args[0]).getSteam3RenderedID(), (err) => {
                                    if (err) logger(`error adding ${args[0]} with bot${i}: ${err}`) 
                                        else logger(`Added ${args[0]} with bot${i} as friend.`)
                                })

                                controller.friendlistcapacitycheck(i); //check remaining friendlist space
                            }, 5000 * i);
                        } else {
                            logger(`bot${i} is already friend with ${args[0]} or the account was blocked/blocked you.`) //somehow logs steamIDs in seperate row?!
                        } 
                    })
                    break;

                case '!unfriend':
                    if (!ownercheck) return notownerresponse();
                    if (isNaN(args[0])) return chatmsg(steamID, lang.invalidprofileid)
                    if (new SteamID(args[0]).isValid() === false) return chatmsg(steamID, lang.invalidprofileid)

                    Object.keys(controller.botobject).forEach((i) => {
                        setTimeout(() => {
                            controller.botobject[i].removeFriend(new SteamID(args[0])) 
                        }, 1000 * i); //delay every iteration so that we don't make a ton of requests at once
                    })

                    chatmsg(steamID, lang.unfriendcmdsuccess.replace("profileid", args[0]))
                    logger(`Removed friend ${args[0]} from all bot accounts.`)
                    break;
                
                case '!unfriendall':
                    if (!ownercheck) return notownerresponse();

                    if (args[0] == "abort") { 
                        chatmsg(steamID, lang.unfriendallcmdabort); 
                        return abortunfriendall = true; 
                    }

                    abortunfriendall = false
                    chatmsg(steamID, lang.unfriendallcmdpending)

                    setTimeout(() => {
                        if (abortunfriendall) return logger("unfriendall process was aborted.");
                        chatmsg(steamID, lang.unfriendallcmdstart)
                        logger("Starting to unfriend everyone...")

                        for (let i in controller.botobject) {
                            for (let friend in controller.botobject[i].myFriends) {
                                try {
                                    setTimeout(() => {
                                        if (!config.ownerid.includes(friend)) controller.botobject[i].removeFriend(new SteamID(friend))
                                    }, 1000 * i); //delay every iteration so that we don't make a ton of requests at once
                                } catch (err) {
                                    logger(`[Bot ${i}] unfriendall error unfriending ${friend}: ${err}`)
                                }
                            }
                        }
                    }, 30000);
                    break;
                
                case '!leavegroup':
                    if (!ownercheck) return notownerresponse();
                    if (isNaN(args[0]) && !String(args[0]).startsWith('https://steamcommunity.com/groups/')) return chatmsg(steamID, lang.leavegroupcmdinvalidgroup)

                    if (String(args[0]).startsWith('https://steamcommunity.com/groups/')) {
                        var leavegroupoutput = ""

                        https.get(`${args[0]}/memberslistxml/?xml=1`, function (leavegroupres) { //get group64id from code to simplify config
                            leavegroupres.on('data', function (chunk) {
                                leavegroupoutput += chunk });

                            leavegroupres.on('end', () => {
                                if (!String(leavegroupoutput).includes("<?xml") || !String(leavegroupoutput).includes("<groupID64>")) { //Check if botsgroupoutput is steam group xml data before parsing it
                                    chatmsg(steamID, lang.leavegroupcmdnotfound)
                                } else {
                                    new xml2js.Parser().parseString(leavegroupoutput, function(err, leavegroupResult) {
                                        if (err) return logger("error parsing leavegroup xml: " + err, true)

                                        args[0] = leavegroupResult.memberList.groupID64
                                        startleavegroup()
                                    }) 
                                } 
                            })
                        }).on("error", function(err) {
                            logger("\x1b[0m[\x1b[31mNotice\x1b[0m]: Couldn't get leavegroup information. Either Steam is down or your internet isn't working.\n          Error: " + err)
                            chatmsg(steamID, lang.leavegroupcmderror + err)
                            return;
                        })

                    } else { 
                        startleavegroup() 
                    }

                    function startleavegroup() { //eslint-disable-line no-inner-declarations, no-case-declarations
                        var argsSteamID = new SteamID(String(args[0]))
                        if (argsSteamID.isValid() === false || argsSteamID["type"] !== 7) return chatmsg(steamID, lang.leavegroupcmdinvalidgroup)

                        Object.keys(controller.botobject).forEach((i) => {
                            setTimeout(() => {
                                if (controller.botobject[i].myGroups[argsSteamID] === 3) controller.communityobject[i].leaveGroup(argsSteamID)
                            }, 1000 * i); //delay every iteration so that we don't make a ton of requests at once
                        })

                        chatmsg(steamID, lang.leavegroupcmdsuccess.replace("profileid", args[0]))
                        logger(`Left group ${args[0]} with all bot accounts.`)
                    }
                    break;
                
                case '!leaveallgroups':
                    if (!ownercheck) return notownerresponse();

                    if (args[0] == "abort") { 
                        chatmsg(steamID, lang.leaveallgroupscmdabort); 
                        return abortleaveallgroups = true; 
                    }

                    abortleaveallgroups = false
                    chatmsg(steamID, lang.leaveallgroupscmdpending)

                    setTimeout(() => {
                        if (abortleaveallgroups) return logger("leaveallgroups process was aborted.");
                        chatmsg(steamID, lang.leaveallgroupscmdstart)
                        logger("Starting to leave all groups...")

                        for (let i in controller.botobject) {
                            for (let group in controller.botobject[i].myGroups) {
                                try {
                                    setTimeout(() => {
                                        if (controller.botobject[i].myGroups[group] == 3) {
                                            if (group != cachefile.botsgroupid && group != cachefile.configgroup64id) controller.communityobject[i].leaveGroup(String(group)) 
                                        }
                                    }, 1000 * i); //delay every iteration so that we don't make a ton of requests at once
                                } catch (err) {
                                    logger(`[Bot ${i}] leaveallgroups error leaving ${group}: ${err}`)
                                }
                            }
                        }
                    }, 15000);
                    break;
                
                case '!block': //Well it kinda works but unblocking doesn't. The friend relationship enum stays at 6
                    if (!ownercheck) return notownerresponse();
                    if (isNaN(args[0])) return chatmsg(steamID, lang.invalidprofileid)
                    if (new SteamID(args[0]).isValid() === false) return chatmsg(steamID, lang.invalidprofileid)

                    Object.keys(controller.botobject).forEach((i) => {
                        controller.botobject[i].blockUser(new SteamID(args[0]), err => { if (err) logger(`[Bot ${i}] error blocking user ${args[0]}: ${err}`) }) 
                    })

                    chatmsg(steamID, lang.blockcmdsuccess.replace("profileid", args[0]))
                    logger(`Blocked ${args[0]} with all bot accounts.`)
                    break;
                
                case '!unblock':
                    if (!ownercheck) return notownerresponse();
                    if (isNaN(args[0])) return chatmsg(steamID, lang.invalidprofileid)
                    if (new SteamID(args[0]).isValid() === false) return chatmsg(steamID, lang.invalidprofileid)

                    Object.keys(controller.botobject).forEach((i) => {
                        if (controller.botobject[i].myFriends[new SteamID(args[0])] === 1) {
                            controller.botobject[i].unblockUser(new SteamID(args[0]), err => { if (err) logger(`[Bot ${i}] error blocking user ${args[0]}: ${err}`) }) 
                        }
                    })

                    chatmsg(steamID, lang.unblockcmdsuccess.replace("profileid", args[0]))
                    logger(`Unblocked ${args[0]} with all bot accounts.`)
                    break;
                
                case '!rs':
                case '!restart':
                    if (!ownercheck) return notownerresponse();

                    chatmsg(steamID, lang.restartcmdrestarting)
                    require('../start.js').restart({ skippedaccounts: updater.skippedaccounts })
                    break;

                case '!stop':
                    if (!ownercheck) return notownerresponse();

                    chatmsg(steamID, lang.stopcmdstopping)
                    require('../start.js').stop()
                    break;
                
                case '!update':
                    if (!ownercheck) return notownerresponse();

                    if (args[0] == "true") { 
                        updater.checkforupdate(true, steamID); 
                        chatmsg(steamID, lang.updatecmdforce.replace("branchname", extdata.branch)) 
                    } else { 
                        updater.checkforupdate(false, steamID); chatmsg(steamID, lang.updatecmdcheck.replace("branchname", extdata.branch))
                    }
                    break;
                
                case '!log':
                case '!output':
                    if (!ownercheck) return notownerresponse();

                    fs.readFile("./output.txt", function (err, data) {
                        if (err) logger("error getting last 25 lines from output for log cmd: " + err)

                        chatmsg(steamID, "These are the last 25 lines:\n\n" + data.toString().split('\n').slice(data.toString().split('\n').length - 25).join('\n')) 
                    })
                    break;
                
                case '!eval':
                    if (config.enableevalcmd !== true) return chatmsg(steamID, lang.evalcmdturnedoff)
                    if (!ownercheck) return notownerresponse();

                    const clean = text => { //eslint-disable-line no-case-declarations
                        if (typeof(text) === "string") return text.replace(/`/g, "`" + String.fromCharCode(8203)).replace(/@/g, "@" + String.fromCharCode(8203));
                            else return text; 
                    }

                    try {
                        const code = args.join(" ");
                        if (code.includes('logininfo')) return chatmsg(steamID, lang.evalcmdlogininfoblock) //not 100% save but should be at least some protection (only owners can use this cmd)
                        
                        let evaled = eval(code);
                        if (typeof evaled !== "string")
                        evaled = require("util").inspect(evaled);
                
                        //Check for character limit and cut message (seems to be 5000)
                        let chatResult = clean(evaled)

                        if (chatResult.length >= 4950) chatmsg(steamID, `Code executed. Result:\n\n${chatResult.slice(0, 4950)}.......\n\n\nResult too long for chat.`)
                            else chatmsg(steamID, `Code executed. Result:\n\n${clean(evaled)}`)
                        
                        logger('\n\x1b[33mEval result:\x1b[0m \n' + clean(evaled) + "\n", true)
                    } catch (err) {
                        chatmsg(steamID, `Error:\n${clean(err)}`)
                        logger('\n\x1b[33mEval error:\x1b[0m \n' + clean(err) + "\n", true)                                                                                                                                                                                                                                                                                                                 //Hi I'm a comment that serves no purpose
                        return; 
                    }
                    break;
                
                default: //cmd not recognized
                    if (message.startsWith("!")) chatmsg(steamID, lang.commandnotfound) 
            }
        } else {
            switch(message.toLowerCase()) {
                case '!about': //Please don't change this message as it gives credit to me; the person who put really much of his free time into this project. The bot will still refer to you - the operator of this instance.
                    chatmsg(steamID, controller.aboutstr)
                    break;
                default:
                    if (message.startsWith("!")) chatmsg(steamID, `${lang.childbotmessage}\nhttps://steamcommunity.com/profiles/${new SteamID(String(controller.botobject[0].steamID)).getSteamID64()}`)
            }
        }
    });

    //Display message when connection was lost to Steam
    bot.on("disconnected", (eresult, msg) => {
        if (controller.relogQueue.includes(loginindex)) return; //disconnect is already handled

        logger(`\x1b[31m[${thisbot}] Lost connection to Steam. Message: ${msg} | Check: https://steamstat.us\x1b[0m`)

        if (!controller.skippednow.includes(loginindex) && controller.relogAfterDisconnect) { //bot.logOff() also calls this event with NoConnection. To ensure the relog function doesn't call itself again here we better check if the account is already being relogged
            logger(`\x1b[32m[${thisbot}] Initiating a relog in 30 seconds.\x1b[0m`) //Announce relog
            setTimeout(() => {
                relogAccount()
            }, 30000);
        } else {
            logger(`[${thisbot}] I won't queue myself for a relog because this account is either already being relogged, was skipped or this is an intended logOff.`)
        }
    })

    //Get new websession as sometimes the bot would relog after a lost connection but wouldn't get a websession. Read more about cookies & expiration: https://dev.doctormckay.com/topic/365-cookies/
    community.on("sessionExpired", () => {
        if (Date.now() - lastWebSessionRefresh < 15000) return; //last refresh was 15 seconds ago so ignore this call

        logger(`[${thisbot}] Session seems to be expired. Trying to get new websession...`)
        lastWebSessionRefresh = Date.now() //update time
        bot.webLogOn()
    })

    module.exports={
        bot,
        activecommentprocess
    }
}

//Code by: https://github.com/HerrEurobeat/ 