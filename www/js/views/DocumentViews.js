/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50 */
/*global define */

// DocumentViews.js 
// Document import / export functionality for AIM. Current formats supported are listed
// in FileTypeEnum below
define(function (require) {

    "use strict";

    const   spaceRE     = /\s+/,            // select 1+ space chars
            nonSpaceRE  = /[^\s+]/,         // select 1+ non-space chars
            CRLF_RE     = /(\r\n|\r|\n)/g,  // select all CRLF variants
            GspaceRE    = /\s+/g;           // globally select all 1+ space chars

    var $               = require('jquery'),
        Underscore      = require('underscore'),
        Handlebars      = require('handlebars'),
        Backbone        = require('backbone'),
        Marionette      = require('marionette'),
        i18n            = require('i18n'),
        projModel       = require('app/models/project'),
        tplLoadingPleaseWait = require('text!tpl/LoadingPleaseWait.html'),
        tplImportDoc    = require('text!tpl/CopyOrImport.html'),
        tplExportDoc    = require('text!tpl/Export.html'),
        tplExportContent = require('text!tpl/ExportContent.html'),
        tplExportFormat = require('text!tpl/ExportChooseFormat.html'),
        tplExportDestination = require('text!tpl/ExportDestination.html'),
        bookModel       = require('app/models/book'),
        spModel         = require('app/models/sourcephrase'),
        chapModel       = require('app/models/chapter'),
        kbModels        = require('app/models/targetunit'),
        userModels      = require('app/models/user'),
        scrIDs          = require('utils/scrIDs'),
        USFM            = require('utils/usfm'),
        kblist          = null, // populated in onShow
        bookName        = "",
        scrID           = "",
        fileName        = "",
        versionSpec     = "", // file type specification version (2.5, 3.0, etc.)
        isClipboard     = false,
        isKB            = false,
        isGlossKB       = false,
        isProjectFile   = false,
        fileCount       = 0,
        batchesSent     = 0,
        intervalID      = 0,
        bookid          = "",
        puncts          = [],
        punctsSource    = [],
        punctsTarget    = [],
        caseSource      = [],
        caseTarget      = [],
        deferreds       = [],
        strContents     = "",
        // EDB 1 Feb 2024: static for the export wizard, to ignore the app process pause/resume events: on Android, the
        // Open and Save plugins pause the app process, so when we get back the "operation succeeded / failed" status messages
        // get knocked out and replaced by the wizard restarting (ugh). I removed the resume handler from the import side completely.
        bOperationDone  = false, 
        END_FT_BIT      = "0000000010000000000000", // pos 13 (4096 in decimal), per Adapt It Desktop
        bOverride       = false,  // if we are merging, do we want to automatically choose this data over what's
                                // in the database?
        MAX_BATCH       = 10000,    // maximum transaction size for SQLite 
                                    // (number can be tuned if needed - this is to avoid memory issues - see issue #138)
        contentEnum = {
            ADAPTATION: 1,
            GLOSS: 2,
            FT: 3
        },
        FileTypeEnum = {
            TXT: 1,
            USFM: 2,    // 3.0 (https://ubsicap.github.io/usfm/index.html) - see also ../utils/usfm.js
            USX: 3,     // 2.5 (https://ubsicap.github.io/usx/)
            XML: 4,
            KBXML: 5,
            KBTMX: 6,    // https://www.ttt.org/oscarStandards/tmx/
            GLOSSKBXML: 7,
            SFM_KB: 8, // SFM with \lx \ge markers
            LIFT: 9 // https://github.com/sillsdev/lift-standard
        },
        DestinationEnum = {
            FILE: 1,
            CLIPBOARD: 2
        },
        LexMkrEnum = {
            LX: 1,  // \lx
            GE: 2,  // \ge
            ERR: 3  // anything else
        },

        // Helper method to build an html list of documents in the AIM database.
        // Used by ExportDocument.
        buildDocumentList = function (pid) {
            var str = "";
            var i = 0;
            var entries = window.Application.BookList.where({projectid: pid});
            // If the KB is not empty, add an entry
            if ((kblist !== null) && (kblist.length > 0)) {
                // non-gloss KB entries (can export to KB .xml or .tmx)
                if (kblist.findWhere({isGloss: 0})) {
                    str += "<li class='topcoat-list__item docListItem' id=\'kb\'><span class='btn-kb'></span>" + i18n.t("view.lblKB") + "<span class='chevron'></span></li>";
                }
                // gloss KB entries (can export to Glosses.xml)
                if (kblist.findWhere({isGloss: 1})) {
                    str += "<li class='topcoat-list__item docListItem' id=\'glosskb\'><span class='btn-glosskb'></span>" + i18n.t("view.lblGlossKB") + "<span class='chevron'></span></li>";
                }
            }
            for (i = 0; i < entries.length; i++) {
                str += "<li class='topcoat-list__item docListItem' id=" + entries[i].attributes.bookid + ">" + entries[i].attributes.name + "<span class='chevron'></span></li>";
            }
            return str;
        },

        // update the status bar during the import / export process -
        // This also controls an optional progress bar for longer-running operations 
        updateStatus = function (str, pct) {
            console.log("updateStatus: " + str);
            $("#status").html(str);
            if (pct) {
                // show the progress bar with the percent complete; hide the "waiting" animation
                if ($("#pb-bg").hasClass("hide")) {
                    $("#pb-bg").removeClass("hide"); 
                    $("#waiting").hide();
                }
                if (pct < 1) {
                    pct = 1;
                } else if (pct > 100) {
                    pct = 100;
                }
                console.log("updateStatus progress: "+ pct + "%");
                $("#pbar").width(pct + "%");
            }
        },

        // Helper method to store the specified source and target text in the KB.
        saveInKB = function (sourceValue, targetValue, oldTargetValue, projectid, isGloss) {
            var elts = kblist.filter(function (element) {
                return (element.attributes.projectid === projectid &&
                   element.attributes.source === sourceValue && element.attributes.isGloss === isGloss);
            });
            var tu = null,
                curDate = new Date(),
                timestamp = (curDate.getFullYear() + "-" + (curDate.getMonth() + 1) + "-" + curDate.getDay() + "T" + curDate.getUTCHours() + ":" + curDate.getUTCMinutes() + ":" + curDate.getUTCSeconds() + "z");
            if (elts.length > 0) {
                // this TU exists in the KB
                tu = elts[0];
            }
            if (tu) {
                var i = 0,
                    found = false,
                    refstrings = tu.get('refstring');
                // delete or decrement the old value
                if (oldTargetValue.length > 0) {
                    // there was an old value -- try to find and remove the corresponding KB entry
                    for (i = 0; i < refstrings.length; i++) {
                        if (refstrings[i].target === oldTargetValue) {
                            if (refstrings[i].n !== '0') {
                                // more than one refcount -- decrement it
                                refstrings[i].n--;
                            }
                            break;
                        }
                    }
                }
                // add or increment the new value
                for (i = 0; i < refstrings.length; i++) {
                    if (refstrings[i].target === targetValue) {
                        refstrings[i].n++;
                        found = true;
                        break;
                    }
                }
                if (found === false) {
                    // no entry in KB with this source/target -- add one
                    var newRS = {
                            'target': targetValue,
                            'n': '1'
                        };
                    refstrings.push(newRS);
                }
                // sort the refstrings collection on "n" (refcount)
                refstrings.sort(function (a, b) {
                    // high to low
                    return parseInt(b.n, 10) - parseInt(a.n, 10);
                });
                // update the KB model
                tu.set('refstring', refstrings, {silent: true});
                tu.set('timestamp', timestamp, {silent: true});
                tu.update();
            } else {
                // no entry in KB with this source -- add one
                var newID = window.Application.generateUUID(),
                    newTU = new kbModels.TargetUnit({
                        tuid: newID,
                        projectid: projectid,
                        source: sourceValue,
                        refstring: [
                            {
                                target: targetValue,
                                n: "1"
                            }
                        ],
                        timestamp: timestamp,
                        user: "",
                        isGloss: isGloss
                    });
                kblist.add(newTU);
                newTU.save();
            }
        },
        

        // Helper method to import the selected file into the specified project.
        // This method has sub-methods for text, usfm, usx and xml (Adapt It document) file types.
        importFile = function (file, project) {
            var reader = new FileReader();
            var result = false;
            var errMsg = "";
            var sps = [];
            if (fileName.length === 0) {
                fileName = file.name; 
            }
            // helper method to flatten the state of an array of deferred objects
            var checkState = function () {
                if (!deferreds) {
                    return "pending";
                }
                var done = true;
                for (var i=0; i<deferreds.length; i++) {
                    if (deferreds[i].state() === "pending") {
                        done = false;
                        return "pending";
                    }
                }
                // if we got here, all the deferreds have resolved or rejected. If _any_ have rejected,
                // return "rejected"; if not, return "resolved"
                for (var i=0; i<deferreds.length; i++) {
                    if (deferreds[i].state() === "rejected") {
                        done = false;
                        return "rejected";
                    }
                }
                return "resolved";
            }           
            // Callback for when the file is imported / saved successfully
            var importSuccess = function () {
                console.log("importSuccess()");
                // hide unneeded UI elements
                $("#LoadingStatus").hide();
                // show the import status and "change the filename" UI
                $("#grpControls").show();
                $("#OKCancelButtons").show();
                $("#selectControls").hide();
                // Did we just import the KB?
                if (isKB === true) {
                    // KB file -- only display success status
                    $("#verifyNameControls").show();
                    $("#lblVerify").hide();
                    $("#rowBookName").hide();
                    $("#lblDirections").html(i18n.t("view.dscStatusKBImportSuccess"));
                } else if (isGlossKB === true) {
                    // Gloss KB file -- only display success status
                    $("#verifyNameControls").show();
                    $("#lblVerify").hide();
                    $("#rowBookName").hide();
                    $("#lblDirections").html(i18n.t("view.dscStatusGlossKBImportSuccess"));
                } else if (isProjectFile === true) {
                    // project file -- only display success status
                    $("#verifyNameControls").show();
                    $("#lblVerify").hide();
                    $("#rowBookName").hide();
                    $("#lblDirections").html(i18n.t("view.dscStatusProjImportSuccess", {document: fileName}));
                } else {
                    // not a KB file:
                    // for regular document files, we did our best to guess a book name --
                    // allow the user to change it if they want
                    $("#verifyNameControls").show();
                    $("#lblDirections").html(i18n.t("view.dscStatusImportSuccess", {document: fileName}));
                    $("#BookName").val(bookName);
                    // select the book name text
                    $("#BookName").trigger("focus");
                    $("#BookName").trigger("select");
                }
                // display the OK button
                $("#OK").removeClass("hide");
                $("#OK").removeAttr("disabled");
            };
            // Callback for when the file failed to import
            var importFail = function (e) {
                console.log("importFail(): " + e.message + " (code: " + e.code + ")");
                // update status with the failure message and code (if available)
                var strReason = e.message;
                if (e.code) {
                    strReason += " (code: " + e.code + ")";
                }
                $("#status").html(i18n.t("view.dscCopyDocumentFailed", {document: fileName, reason: strReason}));
                if ($("#loading").length) {
                    // mobile "please wait" UI
                    $("#loading").hide();
                    $("#waiting").hide();
                    $("#pb-bg").hide();
                }
                // display the OK button
                $("#OKCancelButtons").show();
            };
            
            // callback method for when the FileReader has finished loading in the file
            reader.onloadend = function (e) {
                var s = "",
                    index = 0,
                    norder = 1,
                    markers = "",
                    prepuncts = "",
                    midpuncts = "",
                    follpuncts = "",
                    punctIdx = 0,
                    chapter = null,
                    book = null,
                    books = window.Application.BookList,
                    chapters = window.Application.ChapterList,
                    sourcePhrases = new spModel.SourcePhraseCollection(),
                    arr = [],   // array of content words (for sourcephrases)
                    arrSP = [], // array of spaces (for )
                    bookID = "",
                    chapterID = "",
                    spID = "";

                ///
                // HELPER METHODS
                ///

                // Helper method to strip any starting / ending punctuation from the source or target field.
                // This is used for file imports that populate the KBs, so that we don't have duplicate KB entries:
                // (readXMLDoc, readKBXMLDoc, readGlossXMLDoc, readSFMLexDoc, readTMXDoc)
                // Note that this method also exists in AdaptViews.js, used for updating the KBs during adapting/glossing.
                var stripPunctuation = function (content, isSource) {
                    var result = content,
                        startIdx = 0,
                        endIdx = content.length;
                    // check for empty string
                    if (endIdx === 0) {
                        return result;
                    }
                    if (isSource === false) {
                        // starting index
                        while (startIdx < (content.length - 1) && punctsTarget.indexOf(content.charAt(startIdx)) > -1) {
                            startIdx++;
                        }
                        // ending index
                        while (endIdx > 0 && punctsTarget.indexOf(content.charAt(endIdx - 1)) > -1) {
                            endIdx--;
                        }
                    } else {
                        // starting index
                        while (startIdx < (content.length - 1) && punctsSource.indexOf(content.charAt(startIdx)) > -1) {
                            startIdx++;
                        }
                        // ending index
                        while (endIdx > 0 && punctsSource.indexOf(content.charAt(endIdx - 1)) > -1) {
                            endIdx--;
                        }
                    }
                    // sanity check for all punctuation
                    if (endIdx <= startIdx) {
                        return "";
                    }
                    result = content.substr(startIdx, (endIdx) - startIdx);
                    return result;
                };
                // Helper method to convert theString to lower case using either the source or target case equivalencies.
                // This is used for file imports that populate the KBs, so that we don't have duplicate KB entries:
                // (readXMLDoc, readKBXMLDoc, readGlossXMLDoc, readSFMLexDoc, readTMXDoc)
                // Note that this method also exists in AdaptViews.js, used for updating the KBs during adapting/glossing.
                var autoRemoveCaps = function (theString, isSource) {
                    var i = 0,
                        result = "";
                    // If we aren't capitalizing for this project, just return theString
                    if (project.get('AutoCapitalization') === 'false') {
                        return theString;
                    }
                    // is the first letter capitalized?
                    if (isSource === true) {
                        // use source case equivalencies
                        for (i = 0; i < caseSource.length; i++) {
                            if (caseSource[i].charAt(1) === theString.charAt(0)) {
                                // uppercase -- convert the first character to lowercase and return the result
                                result = caseSource[i].charAt(0) + theString.substr(1);
                                return result;
                            }
                        }
                    } else {
                        // use target case equivalencies
                        for (i = 0; i < caseTarget.length; i++) {
                            if (caseTarget[i].charAt(1) === theString.charAt(0)) {
                                // uppercase -- convert the first character to lowercase and return the result
                                result = caseTarget[i].charAt(0) + theString.substr(1);
                                return result;
                            }
                        }
                    }
                    // If we got here, the string wasn't uppercase -- just return the same string
                    return theString;
                };                

                ///
                // FILE TYPE READERS
                ///
                
                // Plain Text document
                // We assume these are just text with no markup,
                // in a single chapter (this could change if needed)
                var readTextDoc = function (contents) {
                    var newline = new RegExp('[\n\r\f\u2028\u2029]+', 'g');
                    var i = 0;
                    var chaps = [];
                    var sp = null;
                    console.log("Reading text file:" + fileName);
                    index = 1;
                    if (fileName.indexOf(".") > -1) {
                        // most likely has an extension -- remove it for our book name guess
                        bookName = fileName.substring(0, fileName.lastIndexOf('.'));
                    } else {
                        bookName = fileName;
                    }
                    bookID = window.Application.generateUUID();
                    // Create the book and chapter 
                    book = new bookModel.Book({
                        bookid: bookID,
                        projectid: project.get('projectid'),
                        name: bookName,
                        filename: fileName,
                        chapters: []
                    });
                    books.add(book);
                    // (for now, just one chapter -- eventually we could chunk this out based on file size)
                    chapterID = window.Application.generateUUID();
                    chaps.push(chapterID);
                    chapter = new chapModel.Chapter({
                        chapterid: chapterID,
                        bookid: bookID,
                        projectid: project.get('projectid'),
                        name: bookName,
                        lastadapted: 0,
                        versecount: 0
                    });
                    chapters.add(chapter);
                    // set the current bookmark if not already set
                    if (window.Application.currentBookmark === null) {
                        var bookmarkid = window.Application.generateUUID();
                        var newBookmark = new userModels.Bookmark({
                            bookmarkid: bookmarkid,
                            projectid: project.get('projectid'),
                            name: bookName,
                            bookid: bookID,
                            chapterid: chapterID // note: no spID set (will start at beginning)
                        });
                        // save and add to the collection
                        newBookmark.save();
                        window.Application.bookmarkList.add(newBookmark);
                        window.Application.currentBookmark = newBookmark;
                    } else if (window.Application.currentBookmark.get('bookid').length === 0) {
                        // project is set, but the book / chapter values are not set -- set them now
                        window.Application.currentBookmark.set("name", bookName, {silent: true});
                        window.Application.currentBookmark.set("bookid", bookID, {silent: true});
                        window.Application.currentBookmark.set("chapterid", chapterID, {silent: true});
                        window.Application.currentBookmark.update();
                    }

                    // parse the text file and create the SourcePhrases
                    // insert special <p> for linefeeds, then split on whitespace (doesn't keep whitespace)
                    arr = contents.replace(newline, " <p> ").split(spaceRE);
                    arrSP = contents.replace(newline, " <p> ").split(nonSpaceRE);  // do the inverse (keep spaces)
                    i = 0;
                    while (i < arr.length) {
                        // check for a marker
                        if (arr[i].length === 0) {
                            // nothing in this token -- skip
                            i++;
                        } else if (arr[i] === "<p>") {
                            // newline -- make a note and keep going
                            markers = "\\p";
                            i++;
                        } else if (arr[i].length === 1 && puncts.indexOf(arr[i]) > -1) {
                            // punctuation token -- add to the prepuncts
                            prepuncts += arr[i];
                            i++;
                        } else {
                            // "normal" sourcephrase token
                            s = arr[i];
                            // look for leading and trailing punctuation
                            // leading...
                            if (puncts.indexOf(arr[i].charAt(0)) > -1) {
                                // leading punct 
                                punctIdx = 0;
                                while (puncts.indexOf(arr[i].charAt(punctIdx)) > -1 && punctIdx < arr[i].length) {
                                    prepuncts += arr[i].charAt(punctIdx);
                                    punctIdx++;
                                }
                                // remove the punctuation from the "source" of the substring
//                                s = s.substr(punctIdx);
                            }
                            if (punctIdx === s.length) {
                                // it'a ALL punctuation -- jump to the next token
                                i++;
                            } else {
                                // not all punctuation -- check following punctuation, then create a sourcephrase
                                if (puncts.indexOf(s.charAt(s.length - 1)) > -1) {
                                    // trailing punct 
                                    punctIdx = s.length - 1;
                                    while (puncts.indexOf(s.charAt(punctIdx)) > -1 && punctIdx > 0) {
                                        follpuncts += s.charAt(punctIdx);
                                        punctIdx--;
                                    }
                                    // remove the punctuation from the "source" of the substring
//                                    s = s.substr(0, punctIdx + 1);
                                }
                                // Now create a new sourcephrase
                                spID = window.Application.generateUUID();
                                sp = new spModel.SourcePhrase({
                                    spid: spID,
                                    norder: norder,
                                    chapterid: chapterID,
                                    vid: "", // no verses (plain text)
                                    markers: markers,
                                    orig: null,
                                    prepuncts: prepuncts,
                                    midpuncts: midpuncts,
                                    follpuncts: follpuncts,
                                    srcwordbreak: arrSP[i],
                                    source: s,
                                    target: ""
                                });
                                markers = "";
                                prepuncts = "";
                                follpuncts = "";
                                punctIdx = 0;
                                index++;
                                sps.push(sp);
                                // if necessary, send the next batch of SourcePhrase INSERT transactions
                                if ((sps.length % MAX_BATCH) === 0) {
                                    batchesSent++;
                                    updateStatus(i18n.t("view.dscStatusSaving", {number: batchesSent, details: i18n.t("view.detailWords", {count: sps.length})}), 0);
                                    deferreds.push(sourcePhrases.addBatch(sps.slice(sps.length - MAX_BATCH)));
                                    deferreds[deferreds.length - 1].done(function() {
                                        updateStatus(i18n.t("view.dscStatusSavingProgress", {number: deferreds.length, total: batchesSent}), Math.floor(deferreds.length / batchesSent * 100));
                                    });
                                }
                                i++;
                                norder++;
                            }
                        }
                    }

                    // add any remaining sourcephrases
                    if ((sps.length % MAX_BATCH) > 0) {
                        batchesSent++;
                        updateStatus(i18n.t("view.dscStatusSaving", {number: batchesSent, details: i18n.t("view.detailWords", {count: sps.length})}), 0);
                        deferreds.push(sourcePhrases.addBatch(sps.slice(sps.length - (sps.length % MAX_BATCH))));
                        deferreds[deferreds.length - 1].done(function() {
                            updateStatus(i18n.t("view.dscStatusSavingProgress", {number: deferreds.length, total: batchesSent}), Math.floor(deferreds.length / batchesSent * 100));
                        });
                    }
                    // track all those deferred calls to addBatch -- when they all complete, report the results to the user
                    intervalID = window.setInterval(function() {
                        var result = checkState();
                        if (result === "pending") {
                            // pending -- do nothing
                        } else if (result === "resolved") {
                            // resolved
                            clearInterval(intervalID);
                            intervalID = 0;
                            importSuccess();
                        } else {
                            // rejected
                            clearInterval(intervalID);
                            intervalID = 0;
                            importFail(result);
                        }
                    }, 1000);

                    // for non-scripture texts, there are no verses. Keep track of how far we are by using a 
                    // negative value for the # of SourcePhrases in the text.
                    chapter.set('versecount', -(index), {silent: true});
                    chapter.save();
                    book.set('chapters', chaps, {silent: true});
                    book.save();
                    return true; // success
                    // END readTextDoc()
                };
                
                // Paratext USX document
                // These are XML-flavored markup files exported from Paratext
                // (https://ubsicap.github.io/usx/elements.html)
                var readUSXDoc = function (contents) {
                    var sp = null;
                    var chaps = [];
                    var xmlDoc = $.parseXML(contents.replace("<optbreak />", "//"));
                    var $xml = $(xmlDoc);
                    var chapterName = "";
                    // find the USFM ID of this book
                    var scrIDList = new scrIDs.ScrIDCollection();
                    var verseCount = 0;
                    var punctIdx = 0;
                    var i = 0;
                    var lastAdapted = 0;
                    var closingMarker = "";
                    var nodeStyle = "";
                    var verseID = window.Application.generateUUID(); // pre-verse 1 initialization
                    var parseNode = function (element) {
                        nodeStyle = "";
                        // process the node itself
                        if ($(element)[0].nodeType === 1) {
                            switch ($(element)[0].tagName) {
                            case "book":
                                if (markers.length > 0) {
                                    markers += " ";
                                }
                                markers += "\\id " + element.attributes.item("code").nodeValue;
                                break;
                            case "chapter":
                                if (markers.length > 0) {
                                    markers += " ";
                                }
                                markers += "\\c " + element.attributes.item("number").nodeValue;
                                // does this have alt or publishing numbers?
                                if (element.getAttribute("pubnumber") && element.getAttribute("pubnumber").length > 0) {
                                    // verse where the published numbering differs from the number
                                    markers += " \\cp " + element.getAttribute("pubnumber");
                                } else if (element.getAttribute("altnumber") && element.getAttribute("altnumber").length > 0) {
                                    // verse with an alternate numbering
                                    markers += " \\ca " + element.getAttribute("altnumber") + "\\ca*";
                                }
                                if (element.getAttribute("sid") && element.getAttribute("sid").length > 0) {
                                    markers += "\\c-sid " + element.getAttribute("sid");
                                }
                                if (element.getAttribute("eid") && element.getAttribute("eid").length > 0) {
                                    markers += "\\c-eid " + element.getAttribute("eid");
                                }
                                if (element.attributes.item("number").nodeValue !== "1") {
                                    // not the first chapter
                                    // first, close out the previous chapter
                                    chapter.set('versecount', verseCount, {silent: true});
                                    chapter.save();
                                    verseCount = 0; // reset for the next chapter
                                    lastAdapted = 0; // reset for the next chapter
                                    // now create the new chapter
                                    chapterName = i18n.t("view.lblChapterName", {bookName: bookName, chapterNumber: element.attributes.item("number").nodeValue});
                                    chapterID = window.Application.generateUUID();
                                    chaps.push(chapterID);
                                    chapter = new chapModel.Chapter({
                                        chapterid: chapterID,
                                        bookid: bookID,
                                        projectid: project.get('projectid'),
                                        name: chapterName,
                                        lastadapted: 0,
                                        versecount: 0
                                    });
                                    chapters.add(chapter);
                                }
                                break;
                            case "verse":
                                verseCount++;
                                verseID = window.Application.generateUUID();
                                if (markers.length > 0) {
                                    markers += " ";
                                }
                                // first, get the verse and number
                                markers += "\\v " + element.attributes.item("number").nodeValue;
                                // does this have alt or publishing numbers?
                                if (element.getAttribute("pubnumber") && element.getAttribute("pubnumber").length > 0) {
                                    // verse where the published numbering differs from the number
                                    markers += " \\vp " + element.getAttribute("pubnumber") + "\\vp*";
                                } else if (element.getAttribute("altnumber") && element.getAttribute("altnumber").length > 0) {
                                    // verse with an alternate numbering
                                    markers += " \\va " + element.getAttribute("altnumber") + "\\va*";
                                }
                                if (element.getAttribute("sid") && element.getAttribute("sid").length > 0) {
                                    markers += "\\v-sid " + element.getAttribute("sid");
                                }
                                if (element.getAttribute("eid") && element.getAttribute("eid").length > 0) {
                                    markers += "\\v-eid " + element.getAttribute("eid");
                                }
                                break;
                            case "para":
                                // the para kind is in the style tag
                                if (markers.length > 0) {
                                    markers += " ";
                                }
                                markers += "\\" + element.attributes.item("style").nodeValue;
                                break;
                            case "char":
                                // char-related markers, kept in the style attribute
                                if (markers.length > 0) {
                                    markers += " ";
                                }
                                nodeStyle = element.attributes.item("style").nodeValue;
                                if (nodeStyle === "w") {
                                    // wordlist - add lemma, strong, srcloc attributes
                                    markers += "\\w ";
                                    markers += element.childNodes[0].nodeValue; // wordlist item 
                                    markers += "|lemma=\"" + element.getAttribute("lemma") + "\"";
                                    markers += " strong=\"" + element.getAttribute("strong") + "\"";
                                    markers += " srcloc=\"" + element.getAttribute("srcloc") + "\"\\w*";
                                }
                                else if (nodeStyle === "rb") {
                                    // ruby gloss (https://www.w3.org/TR/ruby/) - add gloss attribute
                                    // Note: this used to be \pro - a pronunciation annotation
                                    markers += "\\rb ";
                                    markers += element.childNodes[0].nodeValue; // base word 
                                    markers += "|gloss=\"" + element.getAttribute("gloss") + "\"\\rb*";
                                } else {
                                    // some other char item
                                    markers += "\\" + element.attributes.item("style").nodeValue;
                                    closingMarker = "\\" + element.attributes.item("style").nodeValue + "*";
                                }
                                if (element.getAttribute("link-href") && element.getAttribute("link-href").length > 0) {
                                    markers += " \\z-link-href=\"" + element.getAttributes.item("link-href").nodeValue + "\"";
                                }
                                if (element.getAttribute("link-title") && element.getAttribute("link-title").length > 0) {
                                    markers += " \\z-link-title=\"" + element.getAttributes.item("link-title").nodeValue + "\"";
                                }
                                if (element.getAttribute("link-id") && element.getAttribute("link-id").length > 0) {
                                    markers += " \\z-link-id=\"" + element.getAttributes.item("link-id").nodeValue + "\"";
                                }
                                break;
                            case "ms":
                                // milestone markers (USX 3.0), kept in the style attribute
                                // these can be paired with a sid/eid, or standalone
                                // we don't do anything with these other than store them at the moment
                                if (markers.length > 0) {
                                    markers += " ";
                                }
                                markers += "\\" + element.attributes.item("style").nodeValue;
                                if (element.getAttribute("sid") && element.getAttribute("sid").length > 0) {
                                    markers += "\\ms-sid " + element.getAttribute("sid");
                                }
                                if (element.getAttribute("eid") && element.getAttribute("eid").length > 0) {
                                    markers += "\\ms-eid " + element.getAttribute("sid");
                                }
                                break;
                            case "periph":
                                // peripheral content markers (USX 3.0), kept in the style attribute
                                // these can be paired with a sid/eid, or standalone
                                // we don't do anything with these other than store them at the moment
                                if (markers.length > 0) {
                                    markers += " ";
                                }
                                markers += "\\periph ";
                                markers += element.attributes.item("alt").nodeValue;
                                markers += "|id=\"";
                                markers += element.attributes.item("id").nodeValue;
                                markers += "\"";
                                break;
                            case "figure":
                                if (markers.length > 0) {
                                    markers += " ";
                                }
                                markers += "\\fig ";
                                markers += element.childNodes[0].nodeValue; // inner text is the figure caption
                                // required atts
                                // (note: USX uses "file", while USFM uses "src" for this att)
                                markers += "|src=\"" + element.attributes.item("file").nodeValue + "\"";
                                markers += " size=\"" + element.attributes.item("size").nodeValue + "\"";
                                markers += " ref=\"" + element.attributes.item("ref").nodeValue + "\"";
                                // optional atts
                                if (element.getAttribute("alt") && element.getAttribute("alt").length > 0) {
                                    markers += " alt=\"" + element.attributes.item("alt").nodeValue + "\"";    
                                }
                                if (element.getAttribute("loc") && element.getAttribute("loc").length > 0) {
                                    markers += " loc=\"" + element.attributes.item("loc").nodeValue + "\"";    
                                }
                                if (element.getAttribute("copy") && element.getAttribute("copy").length > 0) {
                                    markers += " copy=\"" + element.attributes.item("copy").nodeValue + "\"";    
                                }
                                closingMarker = "\\fig*";
                                break;
                            case "note":
                                    //caller, style
                                if (markers.length > 0) {
                                    markers += " ";
                                }
                                markers += "\\" + element.getAttribute("style");
                                if (element.getAttribute("caller") && element.getAttribute("caller").length > 0) {
                                    markers += " " + element.getAttribute("caller") + " ";
                                }
                                closingMarker = "\\" + element.getAttribute("style") + "*";
                                if (element.getAttribute("category") && element.getAttribute("category").length > 0) {
                                    markers += "\\cat " + element.getAttribute("category") + "\\cat*";
                                }
                                break;
                            case "optbreak":
                                break; // should not occur -- global replace with "//" at beginning of method
                            case "table":
                                break; // do nothing -- only table rows are kept
                            case "row":
                                if (markers.length > 0) {
                                    markers += " ";
                                }
                                markers += "\\tr";
                                break;
                            case "cell":
                                if (markers.length > 0) {
                                    markers += " ";
                                }
                                // could be header or cell; can also contain alignment
                                // type is found in the style attribute
                                markers += "\\" + element.attributes.item("style").nodeValue;
                                // USFM 3.0 - colspan added to cell/header
                                if (element.getAttribute("colspan") && element.getAttribute("colspan").length > 0) {
                                    markers += "-" + element.getAttribute("colspan");
                                }
                                break;
                            case "sidebar":
                                if (markers.length > 0) {
                                    markers += " ";
                                }
                                markers += "\\esb";
                                if (element.getAttribute("category") && element.getAttribute("category").length > 0) {
                                    markers += " \\cat " + element.getAttribute("category") + "\\cat*";
                                }
                                closingMarker = "\\esbe*";
                                break;
                            case "ref":
                                if (markers.length > 0) {
                                    markers += " ";
                                }
                                markers += element.attributes.item("loc").nodeValue + ";";
                                break;
                            default: // no processing for other nodes
                                break;
                            }
                        }
                        
                        // If this is a text node, create any needed sourcephrases
                        if ($(element)[0].nodeType === 3) {
                            // Split the text into an array
                            // Note that this is analogous to the AI "strip" of text, and not the whole document
                            arr = ($(element)[0].nodeValue).trim().split(spaceRE);
                            arrSP = ($(element)[0].nodeValue).trim().split(nonSpaceRE);
                            i = 0;
                            while (i < arr.length) {
                                // check for a marker
                                if (arr[i].length === 0) {
                                    // nothing in this token -- skip
                                    i++;
                                } else if (arr[i].length === 1 && puncts.indexOf(arr[i]) > -1) {
                                    // punctuation token -- add to the prepuncts
                                    prepuncts += arr[i];
                                    i++;
                                } else {
                                    // "normal" sourcephrase token
                                    s = arr[i];
                                    // look for leading and trailing punctuation
                                    // leading...
                                    if (puncts.indexOf(arr[i].charAt(0)) > -1) {
                                        // leading punct 
                                        punctIdx = 0;
                                        while (puncts.indexOf(arr[i].charAt(punctIdx)) > -1 && punctIdx < arr[i].length) {
                                            prepuncts += arr[i].charAt(punctIdx);
                                            punctIdx++;
                                        }
                                    }
                                    if (punctIdx === s.length) {
                                        // it'a ALL punctuation -- jump to the next token
                                        i++;
                                    } else {
                                        // not all punctuation -- check following punctuation, then create a sourcephrase
                                        if (puncts.indexOf(s.charAt(s.length - 1)) > -1) {
                                            // trailing punct 
                                            punctIdx = s.length - 1;
                                            while (puncts.indexOf(s.charAt(punctIdx)) > -1 && punctIdx > 0) {
                                                follpuncts += s.charAt(punctIdx);
                                                punctIdx--;
                                            }
                                        }
                                        // Now create a new sourcephrase
                                        spID = window.Application.generateUUID();
                                        sp = new spModel.SourcePhrase({
                                            spid: spID,
                                            norder: norder,
                                            chapterid: chapterID,
                                            vid: verseID,
                                            markers: markers,
                                            orig: null,
                                            prepuncts: prepuncts,
                                            midpuncts: midpuncts,
                                            follpuncts: follpuncts,
                                            srcwordbreak: arrSP[i],
                                            source: s,
                                            target: ""
                                        });
                                        markers = "";
                                        prepuncts = "";
                                        follpuncts = "";
                                        punctIdx = 0;
                                        index++;
                                        norder++;
                                        sps.push(sp);
                                        // if necessary, send the next batch of SourcePhrase INSERT transactions
                                        if ((sps.length % MAX_BATCH) === 0) {
                                            batchesSent++;
                                            updateStatus(i18n.t("view.dscStatusSaving", {number: batchesSent, details: i18n.t("view.detailChapterVerse", {chap: chapterName, verse: verseCount})}), 0);
                                            deferreds.push(sourcePhrases.addBatch(sps.slice(sps.length - MAX_BATCH)));
                                            deferreds[deferreds.length - 1].done(function() {
                                                updateStatus(i18n.t("view.dscStatusSavingProgress", {number: deferreds.length, total: batchesSent}), Math.floor(deferreds.length / batchesSent * 100));
                                            });        
                                        }
                                        i++;
                                    }
                                }
                            }
                        }
                        // recurse into children
                        if ($(element).contents().length > 0) {
                            $(element).contents().each(function (idx, elt) {
                                parseNode(elt);
                            });
                        }
                        // done with node -- if there was a closing marker, copy it over to the markers
                        // so it gets picked up in the next sourcephrase
                        if (closingMarker.length > 0) {
                            markers += closingMarker + " "; 
                            closingMarker = "";
                        }
                    };
                    console.log("Reading USX file:" + fileName);
                    versionSpec = $($xml).find("usx").attr("version");
                    if (fileName.indexOf(".") > -1) {
                        // most likely has an extension -- remove it for our book name guess
                        bookName = fileName.substring(0, fileName.lastIndexOf('.'));
                    } else {
                        bookName = fileName;
                    }
                    scrIDList.fetch({reset: true, data: {id: ""}});
                    // the book ID (e.g., "MAT") is in a singleton <book> element of the USX file
                    scrID = scrIDList.where({id: $($xml).find("book").attr("code")})[0];
                    if (scrID === null) {
                        console.log("No ID matching this document: " + $($xml).find("book").attr("code"));
                        errMsg = i18n.t("view.dscErrCannotFindID");
                        return false;
                    }
                    arr = scrID.get('chapters');
                    if (books.where({scrid: (scrID.get('id'))}).length > 0) {
                        // this book is already in the list -- just return
                        errMsg = i18n.t("view.dscErrDuplicateFile");
                        return false;
                    }
                    index = 1;
                    bookID = window.Application.generateUUID();
                    // Create the book and chapter 
                    book = new bookModel.Book({
                        bookid: bookID,
                        projectid: project.get('projectid'),
                        scrid: scrID.get('id'),
                        name: bookName,
                        filename: fileName,
                        chapters: []
                    });
                    books.add(book);
                    chapterID = window.Application.generateUUID();
                    chaps.push(chapterID);
                    chapterName = i18n.t("view.lblChapterName", {bookName: bookName, chapterNumber: "1"});
                    chapter = new chapModel.Chapter({
                        chapterid: chapterID,
                        bookid: bookID,
                        projectid: project.get('projectid'),
                        name: chapterName,
                        lastadapted: 0,
                        versecount: 0
                    });
                    chapters.add(chapter);
                    // set the current bookmark if not already set
                    if (window.Application.currentBookmark === null) {
                        var bookmarkid = window.Application.generateUUID();
                        var newBookmark = new userModels.Bookmark({
                            bookmarkid: bookmarkid,
                            projectid: project.get('projectid'),
                            name: chapterName,
                            bookid: bookID,
                            chapterid: chapterID // note: no spID set (will start at beginning)
                        });
                        // save and add to the collection
                        newBookmark.save();
                        window.Application.bookmarkList.add(newBookmark);
                        window.Application.currentBookmark = newBookmark;
                    } else if (window.Application.currentBookmark.get('bookid').length === 0) {
                        // project is set, but the book / chapter values are not set -- set them now
                        window.Application.currentBookmark.set("name", chapterName, {silent: true});
                        window.Application.currentBookmark.set("bookid", bookID, {silent: true});
                        window.Application.currentBookmark.set("chapterid", chapterID, {silent: true});
                        window.Application.currentBookmark.update();
                    }
                    // now read the contents of the file
                    parseNode($($xml).find("usx"));
                    // add any remaining sourcephrases
                    if ((sps.length % MAX_BATCH) > 0) {
                        batchesSent++;
                        updateStatus(i18n.t("view.dscStatusSaving", {number: batchesSent, details: i18n.t("view.detailChapterVerse", {chap: chapterName, verse: verseCount})}), 0);
                        deferreds.push(sourcePhrases.addBatch(sps.slice(sps.length - (sps.length % MAX_BATCH))));
                        deferreds[deferreds.length - 1].done(function() {
                            updateStatus(i18n.t("view.dscStatusSavingProgress", {number: deferreds.length, total: batchesSent}), Math.floor(deferreds.length / batchesSent * 100));
                        });
                    }
                    // track all those deferred calls to addBatch -- when they all complete, report the results to the user
                    intervalID = window.setInterval(function() {
                        var result = checkState();
                        if (result === "pending") {
                            // pending -- do nothing
                        } else if (result === "resolved") {
                            // resolved
                            clearInterval(intervalID);
                            intervalID = 0;
                            importSuccess();
                        } else {
                            // rejected
                            clearInterval(intervalID);
                            intervalID = 0;
                            importFail(result);
                        }
                    }, 1000);
                    // update the last chapter's verseCount
                    chapter.set('versecount', verseCount, {silent: true});
                    chapter.save();
                    book.set('chapters', chaps, {silent: true});
                    book.save();
                    return true; // success
                    // END readUSXDoc()
                };
                
                // Adapt It Knowledge Base (XML) document
                // While XML is a general purpose document format, we're looking
                // specifically for Adapt It KB files; other files
                // will be skipped (for now). 
                // This import ONLY populates the KB (targetunit tables).
                var readKBXMLDoc = function (contents) {
                    var i = 0,
                        index = 0,
                        elts = null,
                        refstrings = [],
                        projectid = "",
                        xmlDoc = $.parseXML(contents),
                        curDate = new Date(),
                        timestamp = (curDate.getFullYear() + "-" + (curDate.getMonth() + 1) + "-" + curDate.getDay() + "T" + curDate.getUTCHours() + ":" + curDate.getUTCMinutes() + ":" + curDate.getUTCSeconds() + "z"),
                        mn = "",
                        f = "",
                        src = "",
                        tgt = "",
                        srcName = "",
                        defer = $.Deferred(),
                        bMerge = false,
                        tgtName = "";

                    // ** Sanity check #1: Is this a KB? 
                    i = contents.indexOf("<KB ");
                    index = contents.indexOf("kbVersion", i);
                    if (index === -1) {
                        // No kbVersion element found -- this is most likely not a KB document.
                        // Return; we can't parse random xml files.
                        console.log("No kbVersion element found (is this an Adapt It Knowledge Base document?) -- exiting.");
                        errMsg = i18n.t("view.dscErrCannotFindKB");
                        return false;
                    }
                    // ** Sanity check #2: is this KB from a project in our DB? 
                    // (source and target need to match a project in the DB -- if they do, get the project ID)
                    i = contents.indexOf("srcName") + 9;
                    srcName = contents.substring(i, contents.indexOf("\"", i + 1));
                    i = contents.indexOf("tgtName") + 9;
                    tgtName = contents.substring(i, contents.indexOf("\"", i + 1));
                    elts = window.Application.ProjectList.filter(function (element) {
                        return (element.attributes.TargetLanguageName === tgtName &&
                               element.attributes.SourceLanguageName === srcName);
                    });
                    if (elts.length > 0) {
                        // found a match -- pull out the
                        projectid = elts[0].attributes.projectid;
                    } else {
                        // no match -- exit out (need to create a project with this src/tgt before importing a KB)
                        errMsg = i18n.t("view.dscErrWrongKB");
                        return false;
                    }

                    // AIM 1.7.0: KB restore support (#461)
                    // This is a KB that matches our project. Is our KB empty?
                    if (window.Application.kbList.length > 0 && window.Application.kbList.findWhere({isGloss: 0})) {
                        console.log("Import KB / not empty, object count: " + window.Application.kbList.length);
                        // KB NOT empty -- ask the user if they want to restore from this file or just merge with the KB in our DB
                        navigator.notification.confirm(i18n.t("view.dscRestoreOrMergeKB", {document: bookName}), function (buttonIndex) {
                            switch (buttonIndex) {
                            case 1: 
                                // Restore
                                // Delete the existing KB
                                $.when(window.Application.kbList.clearKBForProject(projectid, 0)).done(function() {
                                    window.Application.kbList.reset(); // clear the local list
                                    defer.resolve("Restore selected");
                                });
                                break;
                            case 2: 
                                // Merge
                                defer.resolve("Merge selected");
                                bMerge = true;
                                break;
                            case 3:
                            default: 
                                // User pressed Cancel on import - return to the main screen
                                if (window.history.length > 1) {
                                    // there actually is a history -- go back
                                    window.history.back();
                                } else {
                                    // no history (import link from outside app) -- just go home
                                    window.location.replace("");
                                }
                                return true; // success
                            }
                        }, i18n.t("view.ttlImportKB"), [i18n.t("view.optRestore"), i18n.t("view.optMerge"), i18n.t("view.optCancelImport")]);
                    } else {
                        // KB is empty -- no need for prompt; just import
                        defer.resolve("new KB / no confirm needed, just importing");
                    }

                    defer.then(function (msg) {
                        console.log(msg);    
                        // ** Now start parsing the KB itself
                        isKB = true; // we're importing a knowledge base
                        var $xml = $(xmlDoc);
                        var bFoundRS = false;
                        var theRS = null;
                        var tuCount = 0;
                        markers = "";
                        $($xml).find("MAP > TU").each(function () {
                            // pull out the MAP number - it'll be stored in the mn entry for each TU
                            mn = this.parentNode.getAttribute('mn');
                            // pull out the attributes from the TU element
                            f = this.getAttribute('f');
                            src = stripPunctuation(autoRemoveCaps(this.getAttribute('k'), true), true);
                            tuCount++;
                            if (bMerge === true) {
                                // Merging with an existing KB -- search for this TU in kbList
                                // Note that a Merge will only add to the refcount for existing refstrings, and
                                // add add refstrings that are not found in the db. No other changes are made.
                                var theTU = window.Application.kbList.findWhere([{source: src}, {projectid: projectid}, {isGloss: 0}]);
                                if (theTU) {
                                    bFoundRS = false;
                                    // found a matching TU -- merge the refstrings with the existing ones
                                    $(this).children("RS").each(function (refstring) {
                                        // Does our TU have this refstring?
                                        theRS = theTU.get("refstring"); // refstring in our KB
                                        tgt = stripPunctuation(autoRemoveCaps(refstring.getAttribute('a'), false), false); // target from the file
                                        for (i=0; i< theRS.length; i++) {
                                            if (tgt === theRS[i].target) {
                                                // found the refstring -- add this refcount to the one in our KB
                                                if (Number(theRS[i].n) < 0) {
                                                    // special case -- this value was removed, but now we've got it again:
                                                    // reset the count to 1 in this case
                                                    theRS[i].n = this.getAttribute('n');
                                                } else {
                                                    theRS[i].n = String(Number(theRS[i].n) + Number(this.getAttribute('n')));
                                                }
                                                bFoundRS = true;
                                                break; // done searching
                                            }
                                        }
                                        if (bFoundRS === false) {
                                            // refstring not found -- add a new one
                                            var newRS = {
                                                'target': tgt,  //klb
                                                'n': this.getAttribute('n'),
                                                'cDT': this.getAttribute('cDT'),
                                                'df': this.getAttribute('df'),
                                                'wC': this.getAttribute('wC')
                                            };
                                            // optional attributes for modified / deleted time
                                            if (this.hasAttribute('mDT')) {
                                                newRS['mDT'] = this.getAttribute('mDT');
                                            }
                                            if (this.hasAttribute('dDT')) {
                                                newRS['dDT'] = this.getAttribute('dDT');
                                            }
                                            refstrings.push(newRS);
                                        }
                                    });
                                    // done merging -- save our changes to this TU
                                    theTU.save();                                    
                                } else {
                                    // TU not found -- create a new one with the refstrings from the file
                                    // First collect the refstrings
                                    $(this).children("RS").each(function (refstring) {
                                        var newRS = {
                                            'target': tgt,  //klb
                                            'n': this.getAttribute('n'),
                                            'cDT': this.getAttribute('cDT'),
                                            'df': this.getAttribute('df'),
                                            'wC': this.getAttribute('wC')
                                        };
                                        // optional attributes for modified / deleted time
                                        if (this.hasAttribute('mDT')) {
                                            newRS['mDT'] = this.getAttribute('mDT');
                                        }
                                        if (this.hasAttribute('dDT')) {
                                            newRS['dDT'] = this.getAttribute('dDT');
                                        }
                                        refstrings.push(newRS);
                                    });
                                    // next, sort the refstrings collection on "n" (refcount)
                                    refstrings.sort(function (a, b) {
                                        // high to low
                                        return parseInt(b.n, 10) - parseInt(a.n, 10);
                                    });
                                    // now create the TU
                                    var newID = window.Application.generateUUID();
                                    var newTU = new kbModels.TargetUnit({
                                        tuid: newID,
                                        projectid: projectid,
                                        source: src,
                                        mn: mn,
                                        f: f,
                                        refstring: refstrings.splice(0, refstrings.length),
                                        timestamp: timestamp,
                                        isGloss: 0
                                    });
                                    // add this TU to our internal list and save to the db
                                    newTU.save();
                                }
                            } else {
                                // Not merging -- just create new objects for each item in the file
                                // now collect the refstrings
                                $(this).children("RS").each(function (refstring) {
                                    var newRS = {
                                        'target': tgt,  //klb
                                        'n': this.getAttribute('n'),
                                        'cDT': this.getAttribute('cDT'),
                                        'df': this.getAttribute('df'),
                                        'wC': this.getAttribute('wC')
                                    };
                                    // optional attributes for modified / deleted time
                                    if (this.hasAttribute('mDT')) {
                                        newRS['mDT'] = this.getAttribute('mDT');
                                    }
                                    if (this.hasAttribute('dDT')) {
                                        newRS['dDT'] = this.getAttribute('dDT');
                                    }
                                    refstrings.push(newRS);
                                });
                                // sort the refstrings collection on "n" (refcount)
                                refstrings.sort(function (a, b) {
                                    // high to low
                                    return parseInt(b.n, 10) - parseInt(a.n, 10);
                                });
                                // create the TU
                                // Note that the refstrings array is spliced / cleared out each time
                                var newID = window.Application.generateUUID(),
                                    newTU = new kbModels.TargetUnit({
                                        tuid: newID,
                                        projectid: projectid,
                                        source: src,
                                        mn: mn,
                                        f: f,
                                        refstring: refstrings.splice(0, refstrings.length),
                                        timestamp: timestamp,
                                        isGloss: 0
                                    });
                                // add to our internal list and save to the db
                                newTU.save();
                            }
                        });
                        console.log("imported " + tuCount + " TU objects");
                        // import KB done --
                        // Exit out with SUCCESS status                    
                        importSuccess();
                        return true; // success
                    }); 
                };

                // Lexicon Interchange Format (LIFT) document
                // LIFT was developed by SIL as an interchange format for FLEx and other dictionary tools.
                // AIM does not use all the features of LIFT documents, and so (like in the case of a TMX doc)
                // our LIFT support should be considered lossy and not recommended for round-tripping data.
                var readLIFTDoc = function (contents) {
                    var i = 0,
                        index = 0,
                        refstrings = [],
                        found = false,
                        project = window.Application.currentProject,
                        projectid = project.get("projectid"),
                        xmlDoc = $.parseXML(contents),
                        curDate = new Date(),
                        result = null,
                        srcElt = null,
                        tgtElts = null,
                        tu = null,
                        timestamp = (curDate.getFullYear() + "-" + (curDate.getMonth() + 1) + "-" + curDate.getDay() + "T" + curDate.getUTCHours() + ":" + curDate.getUTCMinutes() + ":" + curDate.getUTCSeconds() + "z"),
                        n = "",
                        mn = "",
                        f = "",
                        tgts = [],
                        src = "",
                        defer = $.Deferred(),
                        bMerge = false;

                    // ** Sanity check #1: Is this a TMX file? 
                    index = contents.indexOf("<lift ");
                    if (index === -1) {
                        // No lift element found -- this is most likely not a lift document.
                        // Return; we can't parse this file.
                        console.log("No lift element found (is this a LIFT file?) -- exiting.");
                        errMsg = i18n.t("view.dscErrCannotFindLIFT");
                        return false;
                    }
                    // ** Sanity check #2: does this LIFT file contain data related to the current project? 
                    index = contents.indexOf(project.get("SourceLanguageCode"));
                    if (index === -1) {
                        // Return; this file doesn't correspond to the current project.
                        console.log("Cannot find source language code -- exiting.");
                        errMsg = i18n.t("view.dscErrCannotFindLangLIFT", {lang: project.get("SourceLanguageCode")});
                        return false;
                    }
                    index = contents.indexOf(project.get("TargetLanguageCode"));
                    if (index === -1) {
                        // Return; this file doesn't correspond to the current project.
                        console.log("Cannot find target language code -- exiting.");
                        errMsg = i18n.t("view.dscErrCannotFindLangLIFT", {lang: project.get("TargetLanguageCode")});
                        return false;
                    }

                    // This is a LIFT file that matches our project. Is our KB empty?
                    if (window.Application.kbList.length > 0 && window.Application.kbList.findWhere({isGloss: 0})) {
                        console.log("Import KB / not empty, object count: " + window.Application.kbList.length);
                        // KB NOT empty -- ask the user if they want to restore from this file or just merge with the KB in our DB
                        navigator.notification.confirm(i18n.t("view.dscRestoreOrMergeTMX", {document: bookName}), function (buttonIndex) {
                            switch (buttonIndex) {
                            case 1: 
                                // Restore
                                // Delete the existing KB
                                $.when(window.Application.kbList.clearKBForProject(projectid, 0)).done(function() {
                                    window.Application.kbList.reset(); // clear the local list
                                    defer.resolve("Restore selected");
                                });
                                break;
                            case 2: 
                                // Merge
                                defer.resolve("Merge selected");
                                bMerge = true;
                                break;
                            case 3:
                            default: 
                                // User pressed Cancel on import - return to the main screen
                                if (window.history.length > 1) {
                                    // there actually is a history -- go back
                                    window.history.back();
                                } else {
                                    // no history (import link from outside app) -- just go home
                                    window.location.replace("");
                                }
                                return true; // success
                            }
                        }, i18n.t("view.ttlImportTMX"), [i18n.t("view.optRestore"), i18n.t("view.optMerge"), i18n.t("view.optCancelImport")]);
                    } else {
                        // KB is empty -- no need for prompt; just import
                        defer.resolve("new KB / no confirm needed, just importing");
                    }

                    defer.then(function (msg) {
                        console.log(msg);
                        // ** Now start parsing the file itself
                        isKB = true; // we're importing a knowledge base
                        var $xml = $(xmlDoc);
                        var tuCount = 0;
                        var rsIdx = 0;
                        markers = "";
                        $($xml).find("entry").each(function () {
                            // pull out the source and target elements from the entry element
                            // find the form that matches our source language code (there can be multiple languages)
                            srcElt = $(this).children("lexical-unit").find("form[lang=\'" + project.get("SourceLanguageCode") + "\']");
                            // find the gloss that matches our target language code (there can be multiple languages)
                            tgtElts = $(this).children("sense").find("gloss[lang=\'"+ project.get("TargetLanguageCode") + "\']"); // could be > 1
                            if ((srcElt.length > 0) && (tgtElts.length > 0)) {
                                n = 1; // no usage count in LIFT - just set count to 1
                                // do we already have this source value in our kblist?
                                src = Underscore.unescape(stripPunctuation(autoRemoveCaps($(srcElt).find("text").html().trim(), true), true));
                                // collect the text from each sense / target -- we'll add them to our refstrings
                                for (i=0; i<tgtElts.length; i++) {
                                    tgts.push(Underscore.unescape(stripPunctuation(autoRemoveCaps($(tgtElts[i]).find("text").html().trim(), false), false)));
                                }
                            } else {
                                return true; // no data in this element -- continue to next entry element
                            }
                            // okay, there's something in the source and target -- are we merging or just populating the KB?
                            tuCount++;
                            if (bMerge === true) {
                                // merging
                                // Merge selected -- check to see if we already have this TU in our kblist
                                var elts = kblist.filter(function (element) {
                                    return (element.attributes.projectid === projectid &&
                                    element.attributes.source === src);
                                });
                                if (elts.length > 0) {
                                    tu = elts[0];
                                    refstrings = tu.get('refstring');
                                    // loop through each sense/target we collected from the lift file
                                    for (rsIdx = 0; rsIdx < tgts.length; rsIdx++) {
                                        found = false;
                                        // do we have a refstring for this target?
                                        for (i = 0; i < refstrings.length; i++) {
                                            if (refstrings[i].target === tgts[rsIdx]) {
                                                // there is a refstring for this target value -- increment it
                                                if (Number(refstrings[i].n) < 0) {
                                                    // special case -- this value was removed, but now we've got it again:
                                                    // reset the count to 1 in this case
                                                    refstrings[i].n = n;
                                                } else {
                                                    refstrings[i].n = String(Number(refstrings[i].n) + Number(n));
                                                }
                                                found = true;
                                                break;
                                            }
                                        }
                                        if (found === false) {
                                            // no entry in KB with this source/target -- add one
                                            var newRS = {
                                                    'target': tgts[rsIdx],  //klb
                                                    'n': '1',
                                                    'cDT': timestamp,
                                                    'df': '0',
                                                    'wC': ""
                                                };
                                            refstrings.push(newRS);
                                        }
                                    }
                                    // done adding all the refstrings for this TU
                                    // now sort the refstrings collection on "n" (refcount)
                                    refstrings.sort(function (a, b) {
                                        // high to low
                                        return parseInt(b.n, 10) - parseInt(a.n, 10);
                                    });
                                    // update the KB model
                                    tu.set('refstring', refstrings, {silent: true});
                                    tu.set('timestamp', timestamp, {silent: true});
                                    tu.update();
                                } else {
                                    // not in list -- create a new TU
                                    var newID = window.Application.generateUUID();
                                    for (i=0; i<tgts.length; i++) {
                                        // build up refstrings array with our tgts
                                        var newRS = {
                                            'target': tgts[i],  //klb
                                            'n': '1',
                                            'cDT': timestamp,
                                            'df': '0',
                                            'wC': ""
                                        };
                                        refstrings.push(newRS);
                                    }
                                    var newTU = new kbModels.TargetUnit({
                                            tuid: newID,
                                            projectid: projectid,
                                            source: src,
                                            refstring: refstrings.splice(0, refstrings.length),
                                            timestamp: timestamp,
                                            user: "",
                                            isGloss: 0
                                        });
                                    newTU.save();
                                    kblist.add(newTU);                                  
                                }

                            } else {
                                // No merge needed -- the KB is empty
                                // is there an existing TU for this element?
                                var elts = kblist.filter(function (element) {
                                    return (element.attributes.projectid === projectid &&
                                    element.attributes.source === src);
                                });
                                if (elts.length > 0) {
                                    // found a TU for this source -- add a new refstring
                                    tu = elts[0];
                                    refstrings = tu.get('refstring');
                                    // loop through each sense/target we collected from the lift file
                                    for (rsIdx = 0; rsIdx < tgts.length; rsIdx++) {
                                        found = false;
                                        // do we have a refstring for the target?
                                        for (i = 0; i < refstrings.length; i++) {
                                            if (refstrings[i].target === tgts[rsIdx]) {
                                                // there is a refstring for this target value -- increment it
                                                if (refstrings[i].n < 0) {
                                                    // special case -- this value was removed, but now we've got it again:
                                                    // reset the count to 1 in this case
                                                    refstrings[i].n = n;
                                                } else {
                                                    refstrings[i].n = refstrings[i].n + n;
                                                }
                                                found = true;
                                                break;
                                            }
                                        }
                                        if (found === false) {
                                            // no entry in KB with this source/target -- add one
                                            var newRS = {
                                                    'target': tgts[rsIdx],  //klb
                                                    'n': '1',
                                                    'cDT': timestamp,
                                                    'df': '0',
                                                    'wC': ""
                                                };
                                            refstrings.push(newRS);
                                        }
                                    }
                                    // sort the refstrings collection on "n" (refcount)
                                    refstrings.sort(function (a, b) {
                                        // high to low
                                        return parseInt(b.n, 10) - parseInt(a.n, 10);
                                    });
                                    // update the KB model
                                    tu.set('refstring', refstrings, {silent: true});
                                    tu.set('timestamp', timestamp, {silent: true});
                                    tu.update();
                                } else {
                                    var newID = window.Application.generateUUID();
                                    for (i=0; i<tgts.length; i++) {
                                        // build up refstrings array with our tgts
                                        var newRS = {
                                            'target': tgts[i],  //klb
                                            'n': '1',
                                            'cDT': timestamp,
                                            'df': '0',
                                            'wC': ""
                                        };
                                        refstrings.push(newRS);
                                    }
                                    var newTU = new kbModels.TargetUnit({
                                            tuid: newID,
                                            projectid: projectid,
                                            source: src,
                                            refstring: refstrings.splice(0, refstrings.length),
                                            timestamp: timestamp,
                                            user: "",
                                            isGloss: 0
                                        });
                                    newTU.save();
                                    kblist.add(newTU);                                  
                                }
                            }
                            // clear out arrays
                            tgts.length = 0;
                        });
                        console.log("imported " + tuCount + " TU objects");
                        // Exit out with SUCCESS status                    
                        importSuccess();
                        return true; // success
                    });
                };

                // Translation Memory Exchange (TMX) document
                // This is an industry standard, and as such only tangentially comforms to Adapt It's model.
                // TMX files potentially have > 2 languages involved, and don't have a 1:many TU/RS mapping. Instead,
                // each <tu> has 1 or more <tuv> elements under it, and we'll need to search for our source/target pair
                // in order to build up the KB.
                // Note: due to our selective import/export, our TMX support should be considered lossy and is not
                // recommended for round-tripping data.
                // This import ONLY populates the KB (targetunit tables).
                var readTMXDoc = function (contents) {
                    var i = 0,
                        index = 0,
                        refstrings = [],
                        found = false,
                        project = window.Application.currentProject,
                        projectid = project.get("projectid"),
                        xmlDoc = $.parseXML(contents),
                        curDate = new Date(),
                        result = null,
                        srcElt = null,
                        tgtElt = null,
                        tu = null,
                        timestamp = (curDate.getFullYear() + "-" + (curDate.getMonth() + 1) + "-" + curDate.getDay() + "T" + curDate.getUTCHours() + ":" + curDate.getUTCMinutes() + ":" + curDate.getUTCSeconds() + "z"),
                        n = "",
                        mn = "",
                        f = "",
                        tgt = "",
                        src = "",
                        defer = $.Deferred(),
                        bMerge = false;
    
                    // ** Sanity check #1: Is this a TMX file? 
                    i = contents.indexOf("<tmx ");
                    index = contents.indexOf("version", i);
                    if (index === -1) {
                        // No version element found -- this is most likely not a tmx document.
                        // Return; we can't parse this file.
                        console.log("No version element found (is this a Translation Memory Exchange file?) -- exiting.");
                        errMsg = i18n.t("view.dscErrCannotFindTMX");
                        return false;
                    }
                    // ** Sanity check #2: does this TMX file contain data related to the current project? 
                    index = contents.indexOf(project.get("SourceLanguageCode"));
                    if (index === -1) {
                        // This is a TMX file, but not for our project
                        // Return; we can't parse this file.
                        console.log("TMX doesn't contain our project's source language code -- exiting.");
                        errMsg = i18n.t("view.dscErrCannotFindLangTMX", {lang: project.get("SourceLanguageCode")});
                        return false;
                    }
                    index = contents.indexOf(project.get("TargetLanguageCode"));
                    if (index === -1) {
                        // This is a TMX file, but not for our project
                        // Return; we can't parse this file.
                        console.log("TMX doesn't contain our project's target language code -- exiting.");
                        errMsg = i18n.t("view.dscErrCannotFindLangTMX", {lang: project.get("TargetLanguageCode")});
                        return false;
                    }

                    // AIM 1.7.0: TMX restore support (#461)
                    // This is a TMX file that matches our project. Is our KB empty?
                    if (window.Application.kbList.length > 0 && window.Application.kbList.findWhere({isGloss: 0})) {
                        console.log("Import KB / not empty, object count: " + window.Application.kbList.length);
                        // KB NOT empty -- ask the user if they want to restore from this file or just merge with the KB in our DB
                        navigator.notification.confirm(i18n.t("view.dscRestoreOrMergeTMX", {document: bookName}), function (buttonIndex) {
                            switch (buttonIndex) {
                            case 1: 
                                // Restore
                                // Delete the existing KB
                                $.when(window.Application.kbList.clearKBForProject(projectid, 0)).done(function() {
                                    window.Application.kbList.reset(); // clear the local list
                                    defer.resolve("Restore selected");
                                });
                                break;
                            case 2: 
                                // Merge
                                defer.resolve("Merge selected");
                                bMerge = true;
                                break;
                            case 3:
                            default: 
                                // User pressed Cancel on import - return to the main screen
                                if (window.history.length > 1) {
                                    // there actually is a history -- go back
                                    window.history.back();
                                } else {
                                    // no history (import link from outside app) -- just go home
                                    window.location.replace("");
                                }
                                return true; // success
                            }
                        }, i18n.t("view.ttlImportTMX"), [i18n.t("view.optRestore"), i18n.t("view.optMerge"), i18n.t("view.optCancelImport")]);
                    } else {
                        // KB is empty -- no need for prompt; just import
                        defer.resolve("new KB / no confirm needed, just importing");
                    }

                    defer.then(function (msg) {
                        console.log(msg);    
                    
                        // ** Now start parsing the file itself
                        isKB = true; // we're importing a knowledge base
                        var $xml = $(xmlDoc);
                        var tuCount = 0;
                        markers = "";
                        $($xml).find("tu").each(function () {
                            // pull out the source and target elements from the tu element
                            srcElt = $(this).children("[xml\\:lang=" + project.get("SourceLanguageCode") + "]");
                            tgtElt = $(this).children("[xml\\:lang=" + project.get("TargetLanguageCode") + "]");
                            if ((srcElt.length > 0) && (tgtElt.length > 0)) {
                                n = this.getAttribute('usagecount');
                                // do we already have this source value in our kblist?
                                src = stripPunctuation(autoRemoveCaps($(srcElt).find("seg").html().trim(), true), true);
                                tgt = stripPunctuation(autoRemoveCaps($(tgtElt).find("seg").html().trim(), false), false);
                            } else {
                                return true; // no data in this elt -- continue to next tu elt
                            }
                            // okay, there's something in the source and target -- are we merging or just populated the KB?
                            tuCount++;
                            if (bMerge === true) {
                                // Merge selected -- check to see if we already have this TU in our kblist
                                var elts = kblist.filter(function (element) {
                                    return (element.attributes.projectid === projectid &&
                                    element.attributes.source === src);
                                });
                                if (elts.length > 0) {
                                    tu = elts[0];
                                    found = false;
                                    refstrings = tu.get('refstring');
                                    // in list -- do we have a refstring for the target?
                                    for (i = 0; i < refstrings.length; i++) {
                                        if (refstrings[i].target === tgt) {
                                            // there is a refstring for this target value -- increment it
                                            if (Number(refstrings[i].n) < 0) {
                                                // special case -- this value was removed, but now we've got it again:
                                                // reset the count to 1 in this case
                                                refstrings[i].n = n;
                                            } else {
                                                refstrings[i].n = String(Number(refstrings[i].n) + Number(n));
                                            }
                                            found = true;
                                            break;
                                        }
                                    }
                                    if (found === false) {
                                        // no entry in KB with this source/target -- add one
                                        var newRS = {
                                                'target': Underscore.unescape(tgt),  //klb
                                                'n': '1',
                                                'cDT': timestamp,
                                                'df': '0',
                                                'wC': ""
                                            };
                                        refstrings.push(newRS);
                                    }
                                    // sort the refstrings collection on "n" (refcount)
                                    refstrings.sort(function (a, b) {
                                        // high to low
                                        return parseInt(b.n, 10) - parseInt(a.n, 10);
                                    });
                                    // update the KB model
                                    tu.set('refstring', refstrings, {silent: true});
                                    tu.set('timestamp', timestamp, {silent: true});
                                    tu.update();
                                } else {
                                    // not in list -- create a new TU
                                    var newID = window.Application.generateUUID(),
                                        newTU = new kbModels.TargetUnit({
                                            tuid: newID,
                                            projectid: projectid,
                                            source: src,
                                            refstring: [
                                                {
                                                    target: Underscore.unescape(tgt),  //klb
                                                    'n': '1',
                                                    'cDT': timestamp,
                                                    'df': '0',
                                                    'wC': ""
                                                }
                                            ],
                                            timestamp: timestamp,
                                            user: "",
                                            isGloss: 0
                                        });
                                    newTU.save();
                                    kblist.add(newTU);                                  
                                }

                            } else {
                                // No merge needed -- the KB is empty
                                // is there an existing TU for this element?
                                var elts = kblist.filter(function (element) {
                                    return (element.attributes.projectid === projectid &&
                                    element.attributes.source === src);
                                });
                                if (elts.length > 0) {
                                    // found a TU for this source -- add a new refstring
                                    tu = elts[0];
                                    found = false;
                                    refstrings = tu.get('refstring');
                                    // in list -- do we have a refstring for the target?
                                    for (i = 0; i < refstrings.length; i++) {
                                        if (refstrings[i].target === tgt) {
                                            // there is a refstring for this target value -- increment it
                                            if (refstrings[i].n < 0) {
                                                // special case -- this value was removed, but now we've got it again:
                                                // reset the count to 1 in this case
                                                refstrings[i].n = n;
                                            } else {
                                                refstrings[i].n = refstrings[i].n + n;
                                            }
                                            found = true;
                                            break;
                                        }
                                    }
                                    if (found === false) {
                                        // no entry in KB with this source/target -- add one
                                        var newRS = {
                                                'target': Underscore.unescape(tgt),  //klb
                                                'n': '1',
                                                'cDT': timestamp,
                                                'df': '0',
                                                'wC': ""
                                            };
                                        refstrings.push(newRS);
                                    }
                                    // sort the refstrings collection on "n" (refcount)
                                    refstrings.sort(function (a, b) {
                                        // high to low
                                        return parseInt(b.n, 10) - parseInt(a.n, 10);
                                    });
                                    // update the KB model
                                    tu.set('refstring', refstrings, {silent: true});
                                    tu.set('timestamp', timestamp, {silent: true});
                                    tu.update();
                                } else {
                                    // not in list -- create a new TU
                                    var newID = window.Application.generateUUID(),
                                        newTU = new kbModels.TargetUnit({
                                            tuid: newID,
                                            projectid: projectid,
                                            source: src,
                                            refstring: [
                                                {
                                                    target: Underscore.unescape(tgt),  //klb
                                                    'n': '1',
                                                    'cDT': timestamp,
                                                    'df': '0',
                                                    'wC': ""
                                                }
                                            ],
                                            timestamp: timestamp,
                                            user: "",
                                            isGloss: 0
                                        });
                                    newTU.save();
                                    kblist.add(newTU);                                  
                                }
                            }
                        });
                        console.log("imported " + tuCount + " TU objects");
                        // Exit out with SUCCESS status                    
                        importSuccess();
                        return true; // success
                    });
                };

                var readGlossXMLDoc = function (contents) {
                    var i = 0,
                        index = 0,
                        elts = null,
                        refstrings = [],
                        projectid = project.get("projectid"),
                        xmlDoc = $.parseXML(contents),
                        curDate = new Date(),
                        timestamp = (curDate.getFullYear() + "-" + (curDate.getMonth() + 1) + "-" + curDate.getDay() + "T" + curDate.getUTCHours() + ":" + curDate.getUTCMinutes() + ":" + curDate.getUTCSeconds() + "z"),
                        mn = "",
                        f = "",
                        src = "",
                        tgt = "",
                        srcName = "",
                        defer = $.Deferred(),
                        bMerge = false,
                        tgtName = "";

                    // ** Sanity check #1: Is this a KB? 
                    i = contents.indexOf("<KB ");
                    index = contents.indexOf("kbVersion", i);
                    if (index === -1) {
                        // No kbVersion element found -- this is most likely not a KB document.
                        // Return; we can't parse random xml files.
                        console.log("No kbVersion element found (is this an Adapt It Knowledge Base document?) -- exiting.");
                        errMsg = i18n.t("view.dscErrCannotFindKB");
                        return false;
                    }

                    // AIM 1.7.0: KB restore support (#461)
                    // This is a KB that matches our project. Is our gloss KB empty?
                    if (window.Application.kbList.length > 0 && window.Application.kbList.findWhere({isGloss: 1})) {
                        console.log("Import KB / not empty, object count: " + window.Application.kbList.length);
                        // KB NOT empty -- ask the user if they want to restore from this file or just merge with the KB in our DB
                        navigator.notification.confirm(i18n.t("view.dscRestoreOrMergeGlossKB", {document: bookName}), function (buttonIndex) {
                            switch (buttonIndex) {
                            case 1: 
                                // Restore
                                // Delete the gloss KB for this project
                                $.when(window.Application.kbList.clearKBForProject(projectid, 1)).done(function() {
                                    window.Application.kbList.reset(); // clear the local list
                                    defer.resolve("Restore selected");
                                });
                                break;
                            case 2: 
                                // Merge
                                defer.resolve("Merge selected");
                                bMerge = true;
                                break;
                            case 3:
                            default: 
                                // User pressed Cancel on import - return to the main screen
                                if (window.history.length > 1) {
                                    // there actually is a history -- go back
                                    window.history.back();
                                } else {
                                    // no history (import link from outside app) -- just go home
                                    window.location.replace("");
                                }
                                return true; // success
                            }
                        }, i18n.t("view.ttlImportGlossKB"), [i18n.t("view.optRestore"), i18n.t("view.optMerge"), i18n.t("view.optCancelImport")]);
                    } else {
                        // KB is empty -- no need for prompt; just import
                        defer.resolve("new KB / no confirm needed, just importing");
                    }

                    defer.then(function (msg) {
                        console.log(msg);    
                        // ** Now start parsing the KB itself
                        isGlossKB = true; // we're importing a gloss knowledge base
                        var $xml = $(xmlDoc);
                        var bFoundRS = false;
                        var theRS = null;
                        var tuCount = 0;
                        markers = "";
                        $($xml).find("MAP > TU").each(function () {
                            // pull out the MAP number - it'll be stored in the mn entry for each TU
                            mn = this.parentNode.getAttribute('mn');
                            // pull out the attributes from the TU element
                            f = this.getAttribute('f');
                            src = stripPunctuation(autoRemoveCaps(this.getAttribute('k'), true), true);
                            tgt = stripPunctuation(autoRemoveCaps(this.getAttribute('a'), false), false);
                            tuCount++;
                            if (bMerge === true) {
                                // Merging with an existing KB -- search for this TU in kbList
                                // Note that a Merge will only add to the refcount for existing refstrings, and
                                // add add refstrings that are not found in the db. No other changes are made.
                                var theTU = window.Application.kbList.findWhere([{source: src}, {projectid: projectid}]);
                                if (theTU) {
                                    bFoundRS = false;
                                    // found a matching TU -- merge the refstrings with the existing ones
                                    $(this).children("RS").each(function (refstring) {
                                        // Does our TU have this refstring?
                                        theRS = theTU.get("refstring");
                                        for (i=0; i< theRS.length; i++) {
                                            if (tgt === theRS[i].target) {
                                                // found the refstring -- add this refcount to the one in our KB
                                                if (Number(theRS[i].n) < 0) {
                                                    // special case -- this value was removed, but now we've got it again:
                                                    // reset the count to 1 in this case
                                                    theRS[i].n = this.getAttribute('n');
                                                } else {
                                                    theRS[i].n = String(Number(theRS[i].n) + Number(this.getAttribute('n')));
                                                }
                                                bFoundRS = true;
                                                break; // done searching
                                            }
                                        }
                                        if (bFoundRS === false) {
                                            // refstring not found -- add a new one
                                            var newRS = {
                                                'target': tgt,  //klb
                                                'n': this.getAttribute('n'),
                                                'cDT': this.getAttribute('cDT'),
                                                'df': this.getAttribute('df'),
                                                'wC': this.getAttribute('wC')
                                            };
                                            // optional attributes for modified / deleted time
                                            if (this.hasAttribute('mDT')) {
                                                newRS['mDT'] = this.getAttribute('mDT');
                                            }
                                            if (this.hasAttribute('dDT')) {
                                                newRS['dDT'] = this.getAttribute('dDT');
                                            }
                                            refstrings.push(newRS);
                                        }
                                    });
                                    // done merging -- save our changes to this TU
                                    theTU.save();                                    
                                } else {
                                    // TU not found -- create a new one with the refstrings from the file
                                    // First collect the refstrings
                                    $(this).children("RS").each(function (refstring) {
                                        var newRS = {
                                            'target': tgt,  //klb
                                            'n': this.getAttribute('n'),
                                            'cDT': this.getAttribute('cDT'),
                                            'df': this.getAttribute('df'),
                                            'wC': this.getAttribute('wC')
                                        };
                                        // optional attributes for modified / deleted time
                                        if (this.hasAttribute('mDT')) {
                                            newRS['mDT'] = this.getAttribute('mDT');
                                        }
                                        if (this.hasAttribute('dDT')) {
                                            newRS['dDT'] = this.getAttribute('dDT');
                                        }
                                        refstrings.push(newRS);
                                    });
                                    // next, sort the refstrings collection on "n" (refcount)
                                    refstrings.sort(function (a, b) {
                                        // high to low
                                        return parseInt(b.n, 10) - parseInt(a.n, 10);
                                    });
                                    // now create the TU
                                    var newID = window.Application.generateUUID();
                                    var newTU = new kbModels.TargetUnit({
                                        tuid: newID,
                                        projectid: projectid,
                                        source: src,
                                        mn: mn,
                                        f: f,
                                        refstring: refstrings.splice(0, refstrings.length),
                                        timestamp: timestamp,
                                        isGloss: 1
                                    });
                                    // add this TU to our internal list and save to the db
                                    newTU.save();
                                }
                            } else {
                                // Not merging -- just create new objects for each item in the file
                                // now collect the refstrings
                                $(this).children("RS").each(function (refstring) {
                                    var newRS = {
                                        'target': tgt,  //klb
                                        'n': this.getAttribute('n'),
                                        'cDT': this.getAttribute('cDT'),
                                        'df': this.getAttribute('df'),
                                        'wC': this.getAttribute('wC')
                                    };
                                    // optional attributes for modified / deleted time
                                    if (this.hasAttribute('mDT')) {
                                        newRS['mDT'] = this.getAttribute('mDT');
                                    }
                                    if (this.hasAttribute('dDT')) {
                                        newRS['dDT'] = this.getAttribute('dDT');
                                    }
                                    refstrings.push(newRS);
                                });
                                // sort the refstrings collection on "n" (refcount)
                                refstrings.sort(function (a, b) {
                                    // high to low
                                    return parseInt(b.n, 10) - parseInt(a.n, 10);
                                });
                                // create the TU
                                // Note that the refstrings array is spliced / cleared out each time
                                var newID = window.Application.generateUUID(),
                                    newTU = new kbModels.TargetUnit({
                                        tuid: newID,
                                        projectid: projectid,
                                        source: src,
                                        mn: mn,
                                        f: f,
                                        refstring: refstrings.splice(0, refstrings.length),
                                        timestamp: timestamp,
                                        isGloss: 1
                                    });
                                // add to our internal list and save to the db
                                newTU.save();
                            }
                        });
                        console.log("imported " + tuCount + " TU objects");
                        // import KB done --
                        // Exit out with SUCCESS status                    
                        importSuccess();
                        return true; // success
                    }); 
                };                
                
                // Adapt It XML document
                // While XML is a general purpose document format, we're looking
                // specifically for Adapt It XML document files; other files
                // will be skipped (for now). 
                // This import also populates the KB and sets the last translated verse in each chapter.
                // Languages must match the current project's source AND target language
                var readXMLDoc = function (contents) {
                    var prepunct = "";
                    var follpunct = "";
                    var src = "";
                    var mkr = "";
                    var sp = null;
                    var chaps = [];
                    var xmlDoc = $.parseXML(contents);
                    var chapterName = "";
                    // find the USFM ID of this book
                    var scrIDList = new scrIDs.ScrIDCollection();
                    var verseCount = 0;
                    var verseID = window.Application.generateUUID();
                    var lastAdapted = 0;
                    var markers = "";
                    var firstChapterNumber = "1";
                    var origTarget = "";
                    var markerList = new USFM.MarkerCollection();
                    var i = 0;
                    var moreFilter = false;
                    var filterIdx = 0;
                    var filterElts = null;
                    var elt = "";
                    var tmpIdx = 0;
                    var searchIdx = 0;
                    var firstBook = false;
                    var isMergedDoc = false;
                    
                    console.log("Reading XML file:" + fileName);
                    bookName = ""; // reset
                    // Book name
                    // Try to get the adapted book name from the \h marker, if it exists
                    if (contents.indexOf("\\h ") > 0) {
                        // there is a \h marker -- look backwards for the nearest "a" attribute (this is the adapted name)
                        index = contents.indexOf("\\h ");
                        i = contents.lastIndexOf("s=", index) + 3;
                        // Sanity check -- this \\h element might not have an adaptation
                        // (if it doesn't, there won't be a a="" after the s="" attribute)
                        if (contents.lastIndexOf("a=", index) > i) {
                            // Okay, this looks legit. Pull out the adapted book name from the file.
                            index = contents.lastIndexOf("a=", index) + 3;
                            bookName = contents.substr(index, contents.indexOf("\"", index) - index);
                        }
                    }
                    // If that didn't work, use the filename
                    if (bookName === "") {
                        if (fileName.indexOf(".") > -1) {
                            // most likely has an extension -- remove it for our book name guess
                            bookName = fileName.substring(0, fileName.lastIndexOf('.'));
                        } else {
                            bookName = fileName;
                        }
                        if (bookName.indexOf("_Collab") > -1) {
                            // Collab document -- strip out the _Collab_ and _CH<#> for the name
                            bookName = bookName.substr(8, bookName.lastIndexOf("_CH") - 8);
                        }
                    }
                    // Sanity check -- this needs to be an AI XML document (we don't support other xml files right now)
                    scrIDList.fetch({reset: true, data: {id: ""}});
                    markerList.fetch({reset: true, data: {name: ""}});
                    // Starting at the SourcePhrases ( <S ...> ), look for the \id element
                    // in the markers. We'll test this against the canonical usfm markers to learn more about this document.
                    i = contents.indexOf("<S ");
                    index = contents.indexOf("\\id", i);
                    if (index === -1) {
                        // No ID found -- this is most likely not an AI xml document.
                        // Return; we can't parse random xml files.
                        console.log("No ID element found (is this an AI XML document?) -- exiting.");
                        errMsg = i18n.t("view.dscErrCannotFindID");
                        return false;
                    }
                    // We've found the \id element in the markers -- to get the value, we have to work
                    // backwards until we find the nearest "s" attribute
                    // e.g., <S s="MAT" ...>.
                    index = contents.lastIndexOf("s=", index) + 3;
                    scrID = scrIDList.where({id: contents.substr(index, contents.indexOf("\"", index) - index)})[0];
                    arr = scrID.get('chapters');
                    if (books.where({scrid: (scrID.get('id'))}).length > 0) {
                        // ** COLLABORATION SUPPORT **
                        // This book is already in our database -
                        // it could either be a duplicate book / file OR a different chapter from a
                        // collaboration document. Figure out which by finding the first chapter marker
                        // and seeing if it's already in our database
                        book = books.where({scrid: (scrID.get('id'))})[0]; // set to the existing book
                        index = contents.indexOf("\\c ", 0); // first chapter marker
                        if (index > 0) {
                            // pull out the chapter number
                            firstChapterNumber = contents.substr(index + 3, contents.indexOf(" ", index + 3) - (index + 3));
                            if (firstChapterNumber === "1") {
                                firstBook = true;
                            }
                            // look up the chapter number -- is it something we already have?
                            chapterName = i18n.t("view.lblChapterName", {bookName: book.get("bookid"), chapterNumber: firstChapterNumber});
                            if (chapters.where({name: chapterName}).length > 0) {
                                // This is a duplicate -- return
                                errMsg = i18n.t("view.dscErrDuplicateFile");
                                return false;
                            }
                            // If we got this far, we're looking at a collaboration document -
                            // we'll be merging in the new data into the existing book
                            isMergedDoc = true;
                            if (firstBook === true) {
                                // The user has merged in the first chapter AFTER importing a subsequent chapter --
                                // this shouldn't happen (see the logic block below that disallows it). Just in case,
                                // try to offset the damage by updating the book name to what this chapter holds.
                                book.set('name', bookName);
                            } else {
                                // Not the first chapter -- use the book name in the database object.
                                bookName = book.get("name");
                            }
                            bookID = book.get("bookid");
                            chaps = book.get("chapters"); // set to the chapters already imported in the book (we'll add to this array)
                        } else {
                            // No chapter found (but there is an ID) -- return
                            errMsg = i18n.t("view.dscErrCannotFindChapter");
                            return false;
                        }
                    } else {
                        // This is a new book
                        // Make a note of the first chapter number. Disallow collab documents where the first chapter is
                        // NOT the first document being imported, as this creates a headache for book naming / lookups.
                        index = contents.indexOf("\\c ", 0); // first chapter marker
                        if (index > 0) {
                            // pull out the chapter number
                            firstChapterNumber = contents.substr(index + 3, contents.indexOf(" ", index + 3) - (index + 3));
                            if (firstChapterNumber === "1") {
                                firstBook = true;
                            } else {
                                // User attempting to import collab document without importing the first chapter first;
                                // error out
                                errMsg = i18n.t("view.dscErrImportFirstChapterFirst");
                                return false;
                            }
                        }
                        // Create the book and chapter 
                        bookID = window.Application.generateUUID();
                        bookName = i18n.t('view.' + scrID.get('id'));
                        book = new bookModel.Book({
                            bookid: bookID,
                            projectid: project.get('projectid'),
                            scrid: scrID.get('id'),
                            name: bookName,
                            filename: fileName,
                            chapters: []
                        });
                        books.add(book);
                    }
                    // Reset the index to the beginning of the file
                    index = 1;
                    // Add the first chapter
                    chapterID = window.Application.generateUUID();
                    chaps.push(chapterID);
                    chapterName = i18n.t("view.lblChapterName", {bookName: bookName, chapterNumber: firstChapterNumber});
                    chapter = new chapModel.Chapter({
                        chapterid: chapterID,
                        bookid: bookID,
                        projectid: project.get('projectid'),
                        name: chapterName,
                        lastadapted: 0,
                        versecount: 0
                    });
                    chapters.add(chapter);
                    // set the current bookmark if not already set
                    if (window.Application.currentBookmark === null) {
                        var bookmarkid = window.Application.generateUUID();
                        var newBookmark = new userModels.Bookmark({
                            bookmarkid: bookmarkid,
                            projectid: project.get('projectid'),
                            name: chapterName,
                            bookid: bookID,
                            chapterid: chapterID // note: no spID set (will start at beginning)
                        });
                        // save and add to the collection
                        newBookmark.save();
                        window.Application.bookmarkList.add(newBookmark);
                        window.Application.currentBookmark = newBookmark;
                    } else if (window.Application.currentBookmark.get('bookid').length === 0) {
                        // project is set, but the book / chapter values are not set -- set them now
                        window.Application.currentBookmark.set("name", chapterName, {silent: true});
                        window.Application.currentBookmark.set("bookid", bookID, {silent: true});
                        window.Application.currentBookmark.set("chapterid", chapterID, {silent: true});
                        window.Application.currentBookmark.update();
                    }
                    // create the sourcephrases
                    var $xml = $(xmlDoc);
                    var stridx = 0;
                    var chapNum = "";
                    markers = "";
                    $($xml).find("AdaptItDoc > S").each(function (i) {
                        origTarget = ""; // initialize merge original target text
                        if (i === 0 && firstBook === false) {
                            // merged (collaboration) documents have an extra "\id" element at the beginning of subsequent chapters;
                            // ignore this element and continue to the next one
                            return true; // jquery equivalent of continue in loop
                        }
                        // If this is a new chapter (starting for ch 2 -- chapter 1 is created above),
                        // create a new chapter object
                        // EDB 22 Aug 17 note: we're adding to the markers rather than setting; for the \x* ending marker, we need to
                        // move it forward to the next source phrase. MAKE SURE [markers] GETS CLEARED OUT IN OTHER CASES.
                        if ($(this).attr('m')) {
                            markers += $(this).attr('m');
                        }
                        if (markers && markers.indexOf("\\c ") !== -1) {
                            // is this the first chapter marker? If so, ignore it (we already created it above)
                            stridx = markers.indexOf("\\c ") + 3;
                            chapNum = markers.substr(stridx, markers.indexOf(" ", stridx) - stridx);
                            if (chapNum !== firstChapterNumber) {
                                // This is not our first chapter, so we can create it
                                // update the last adapted for the previous chapter before closing it out
                                chapter.set('versecount', verseCount, {silent: true});
                                chapter.set('lastadapted', lastAdapted, {silent: true});
                                chapter.save();
                                verseCount = 0; // reset for the next chapter
                                lastAdapted = 0; // reset for the next chapter
                                stridx = markers.indexOf("\\c ") + 3;
                                chapterName = i18n.t("view.lblChapterName", {bookName: bookName, chapterNumber: markers.substr(stridx, markers.indexOf(" ", stridx) - stridx)});
                                chapterID = window.Application.generateUUID();
                                chaps.push(chapterID);
                                // create the new chapter
                                chapter = new chapModel.Chapter({
                                    chapterid: chapterID,
                                    bookid: bookID,
                                    projectid: project.get('projectid'),
                                    name: chapterName,
                                    lastadapted: 0,
                                    versecount: 0
                                });
                                chapters.add(chapter);
                                //  console.log(": " + $(this).attr('s') + ", " + chapterID);
                            }
                        }
                        if (markers && markers.indexOf("\\v ") !== -1) {
                            verseCount++;
                            verseID = window.Application.generateUUID();
                            // check this sourcephrase for a target - if there is one, consider this verse adapted
                            // (note that we're only checking the FIRST sp of each verse, not EVERY sp in the verse)
                            if ($(this).attr('t')) {
                                lastAdapted++;
                            }
                        }
                        
                        // phrase -- collect the original target words
                        if ($(this).attr('w') > 1) {
                            // child sourcephrases -- a merge?
                            $(this).children().each(function (childIdx, childVal) {
                                if (childIdx > 0) {
                                    origTarget += "|";
                                }
                                if ($(childVal).attr('t')) {
                                    origTarget += $(childVal).attr("t");
                                }
                            });
                        }
                        
                        // create the next sourcephrase
                        // console.log(i + ": " + $(this).attr('s') + ", " + chapterID);
                        if (origTarget.length > 0) {
                            // phrase -- spID has a prefix of "phr-"
                            spID = "phr-" + window.Application.generateUUID();
                        } else {
                            spID = window.Application.generateUUID();
                        }
                        sp = new spModel.SourcePhrase({
                            spid: spID,
                            norder: norder,
                            chapterid: chapterID,
                            vid: verseID,
                            markers: markers, //$(this).attr('m'),
                            orig: (origTarget.length > 0) ? origTarget : null,
                            prepuncts: $(this).attr('pp'),
                            midpuncts: "",
                            follpuncts: $(this).attr('fp'),
                            flags: $(this).attr('f'),
                            texttype: $(this).attr('ty'),
                            gloss: $(this).attr('g'),
                            freetrans: $(this).attr('ft'),
                            note: $(this).attr('no'),
                            srcwordbreak: $(this).attr('swbk'),
                            tgtwordbreak: $(this).attr('twbk'),
                            source: $(this).attr('s'), // source (w/punctuation)
                            target: $(this).attr('t')
                        });
                        index++;
                        norder++;
                        sps.push(sp);
                        // if necessary, send the next batch of SourcePhrase INSERT transactions
                        if ((sps.length % MAX_BATCH) === 0) {
                            batchesSent++;
                            updateStatus(i18n.t("view.dscStatusSaving", {number: batchesSent, details: i18n.t("view.detailChapterVerse", {chap: chapterName, verse: verseCount})}), 0);
                            deferreds.push(sourcePhrases.addBatch(sps.slice(sps.length - MAX_BATCH)));
                            deferreds[deferreds.length - 1].done(function() {
                                updateStatus(i18n.t("view.dscStatusSavingProgress", {number: deferreds.length, total: batchesSent}), Math.floor(deferreds.length / batchesSent * 100));
                            });
                        }
                        // add this item to the KB
                        // TODO: build up punctpairs
                        if (sp.get('target').length > 0) {
                            saveInKB(stripPunctuation(autoRemoveCaps(sp.get('source'), true), true), stripPunctuation(autoRemoveCaps($(this).attr('a'), false), false),
                            "", project.get('projectid'), 0);
                        }
                        // is there a gloss?
                        if ($(this).attr('g')) {
                            // yes -- add it to the gloss KB
                            saveInKB(stripPunctuation(autoRemoveCaps(sp.get('source'), true), true), stripPunctuation(autoRemoveCaps($(this).attr('g'), false), false),
                            "", project.get('projectid'), 1);
                        }
                        markers = ""; // clear out the markers for the next wourcephrase
                        
                        // Last of all, add the filter data
                        // if there are filtered text items, insert them now
                        if ($(this).attr('fi')) {
                            moreFilter = true;
                            console.log("fi: " + $(this).attr('fi'));
                            filterElts = $(this).attr('fi').split(spaceRE);
                            filterIdx = 0;
                            searchIdx = 0;
                            while (moreFilter === true) {
                                elt = filterElts[filterIdx];
                                if (elt.indexOf("~FILTER") > -1) {
                                    // do nothing -- skip first and last elements
                                    filterIdx++;
                                    searchIdx += elt.length;
                                } else if (elt.indexOf("\\") === 0) {
                                    // starting marker -- check to see if this marker requires an ending marker
                                    mkr = markerList.where({name: elt.substr(elt.indexOf("\\") + 1)});
                                    if (mkr.length > 0 && mkr[0].get("endMarker")) {
                                        // this needs an end marker -- take the entire filter up to the end marker
                                        // and create a single sourcephrase out of it
                                        if ($(this).attr('fi').indexOf(mkr[0].get("endMarker"), searchIdx) > -1) {
                                            markers = elt; // flag this sourcephrase as being filtered by this element
                                            tmpIdx = $(this).attr('fi').indexOf(elt, searchIdx) + elt.length;
                                            src = $(this).attr('fi').substring(tmpIdx, $(this).attr('fi').indexOf(mkr[0].get("endMarker"), searchIdx) - 1); // filter string from elt to the end marker
                                            // update the loop index to the end marker's location in the array
                                            while (filterIdx < filterElts.length && filterElts[filterIdx].indexOf(mkr[0].get("endMarker")) === -1) {
                                                filterIdx++;
                                            }
                                            filterIdx++;
                                            searchIdx += src.length;
                                            console.log("Filter with end marker: " + src);
                                        } else {
                                            // ERROR: no ending marker! 
                                            console.log("Error: no ending marker for elt: " + elt);
                                            // Try to recover... just pull to the end of the filter string
                                            src = $(this).attr('fi').substr($(this).attr('fi').indexOf(elt));
                                            moreFilter = false; // end the loop -- no more filter string
                                            filterIdx = filterElts.length;
                                        }
                                        // create the sourcephrase
                                        // ending marker - it's concatenated with the preceding token, no space
                                        // (1) create a sourcephrase with the first part of the token (without the ending marker)
                                        if (origTarget.length > 0) {
                                            // phrase -- spID has a prefix of "phr-"
                                            spID = "phr-" + window.Application.generateUUID();
                                        } else {
                                            spID = window.Application.generateUUID();
                                        }
                                        sp = new spModel.SourcePhrase({
                                            spid: spID,
                                            norder: norder,
                                            chapterid: chapterID,
                                            vid: verseID,
                                            markers: markers,
                                            orig: (origTarget.length > 0) ? origTarget : null,
                                            prepuncts: "",
                                            midpuncts: "",
                                            follpuncts: "",
                                            flags: "",
                                            texttype: 0,
                                            gloss: "",
                                            freetrans: "",
                                            note: "",
                                            srcwordbreak: $(this).attr('swbk'),
                                            tgtwordbreak: $(this).attr('twbk'),
                                            source: src,
                                            target: ""
                                        });
                                        index++;
                                        norder++;
                                        sps.push(sp);
                                        // if necessary, send the next batch of SourcePhrase INSERT transactions
                                        if ((sps.length % MAX_BATCH) === 0) {
                                            batchesSent++;
                                            updateStatus(i18n.t("view.dscStatusSaving", {number: batchesSent, details: i18n.t("view.detailChapterVerse", {chap: chapterName, verse: verseCount})}), 0);
                                            deferreds.push(sourcePhrases.addBatch(sps.slice(sps.length - MAX_BATCH)));
                                            deferreds[deferreds.length - 1].done(function() {
                                                updateStatus(i18n.t("view.dscStatusSavingProgress", {number: deferreds.length, total: batchesSent}), Math.floor(deferreds.length / batchesSent * 100));
                                            });        
                                        }
                                        markers = ""; // reset
                                    } else {
                                        // no end marker -- needs to be everything up to the ending FILTER
                                        console.log("Filter witn NO end marker: " + elt);
                                        markers += elt;
                                        filterIdx++;
                                        tmpIdx = $(this).attr('fi').indexOf(elt, searchIdx) + elt.length;
                                        src = $(this).attr('fi').substring(tmpIdx, $(this).attr('fi').indexOf("~FILTER", searchIdx) - 1);
                                        // update the loop index to the end marker's location in the array
                                        while (filterIdx < filterElts.length && filterElts[filterIdx].indexOf(mkr[0].get("endMarker")) === -1) {
                                            filterIdx++;
                                        }
                                        filterIdx++;
                                        searchIdx += src.length;
                                        console.log("Filter with end marker: " + src);
                                        if (origTarget.length > 0) {
                                            // phrase -- spID has a prefix of "phr-"
                                            spID = "phr-" + window.Application.generateUUID();
                                        } else {
                                            spID = window.Application.generateUUID();
                                        }
                                        sp = new spModel.SourcePhrase({
                                            spid: spID,
                                            norder: norder,
                                            chapterid: chapterID,
                                            vid: verseID,
                                            markers: markers,
                                            orig: (origTarget.length > 0) ? origTarget : null,
                                            prepuncts: "",
                                            midpuncts: "",
                                            follpuncts: "",
                                            flags: "",
                                            texttype: 0,
                                            gloss: "",
                                            freetrans: "",
                                            note: "",
                                            srcwordbreak: $(this).attr('swbk'),
                                            tgtwordbreak: $(this).attr('twbk'),
                                            source: src,
                                            target: ""
                                        });
                                        index++;
                                        norder++;
                                        sps.push(sp);
                                        // if necessary, send the next batch of SourcePhrase INSERT transactions
                                        if ((sps.length % MAX_BATCH) === 0) {
                                            batchesSent++;
                                            updateStatus(i18n.t("view.dscStatusSaving", {number: batchesSent, details: i18n.t("view.detailChapterVerse", {chap: chapterName, verse: verseCount})}), 0);
                                            deferreds.push(sourcePhrases.addBatch(sps.slice(sps.length - MAX_BATCH)));
                                            deferreds[deferreds.length - 1].done(function() {
                                                updateStatus(i18n.t("view.dscStatusSavingProgress", {number: deferreds.length, total: batchesSent}), Math.floor(deferreds.length / batchesSent * 100));
                                            });        
                                        }
                                        markers = ""; // reset                                        
                                    }
                                } else if (elt.indexOf("\\") > 0) {
                                    // ending marker - it's concatenated with the preceding token, no space
                                    // (1) create a sourcephrase with the first part of the token (without the ending marker)
                                    if (origTarget.length > 0) {
                                        // phrase -- spID has a prefix of "phr-"
                                        spID = "phr-" + window.Application.generateUUID();
                                    } else {
                                        spID = window.Application.generateUUID();
                                    }
                                    sp = new spModel.SourcePhrase({
                                        spid: spID,
                                        norder: norder,
                                        chapterid: chapterID,
                                        vid: verseID,
                                        markers: markers,
                                        orig: (origTarget.length > 0) ? origTarget : null,
                                        prepuncts: "",
                                        midpuncts: "",
                                        follpuncts: "",
                                        flags: "",
                                        texttype: 0,
                                        gloss: "",
                                        freetrans: "",
                                        note: "",
                                        srcwordbreak: $(this).attr('swbk'),
                                        tgtwordbreak: $(this).attr('twbk'),
                                        source: elt.substr(0, elt.indexOf("\\")),
                                        target: ""
                                    });
                                    index++;
                                    norder++;
                                    sps.push(sp);
                                    // if necessary, send the next batch of SourcePhrase INSERT transactions
                                    if ((sps.length % MAX_BATCH) === 0) {
                                        batchesSent++;
                                        updateStatus(i18n.t("view.dscStatusSaving", {number: batchesSent, details: i18n.t("view.detailChapterVerse", {chap: chapterName, verse: verseCount})}), 0);
                                        deferreds.push(sourcePhrases.addBatch(sps.slice(sps.length - MAX_BATCH)));
                                        deferreds[deferreds.length - 1].done(function() {
                                            updateStatus(i18n.t("view.dscStatusSavingProgress", {number: deferreds.length, total: batchesSent}), Math.floor(deferreds.length / batchesSent * 100));
                                        });
                                    }
                                    markers = ""; // reset
                                    filterIdx++;
                                } else {
                                    // regular token - add as a new sourcephrase
                                    if (origTarget.length > 0) {
                                        // phrase -- spID has a prefix of "phr-"
                                        spID = "phr-" + window.Application.generateUUID();
                                    } else {
                                        spID = window.Application.generateUUID();
                                    }
                                    sp = new spModel.SourcePhrase({
                                        spid: spID,
                                        norder: norder,
                                        chapterid: chapterID,
                                        vid: verseID,
                                        markers: markers,
                                        orig: (origTarget.length > 0) ? origTarget : null,
                                        prepuncts: "",
                                        midpuncts: "",
                                        follpuncts: "",
                                        flags: "",
                                        texttype: 0,
                                        gloss: "",
                                        freetrans: "",
                                        note: "",
                                        srcwordbreak: $(this).attr('swbk'),
                                        tgtwordbreak: $(this).attr('twbk'),
                                        source: elt,
                                        target: ""
                                    });
                                    index++;
                                    norder++;
                                    sps.push(sp);
                                    // if necessary, send the next batch of SourcePhrase INSERT transactions
                                    if ((sps.length % MAX_BATCH) === 0) {
                                        batchesSent++;
                                        updateStatus(i18n.t("view.dscStatusSaving", {number: batchesSent, details: i18n.t("view.detailChapterVerse", {chap: chapterName, verse: verseCount})}), 0);
                                        deferreds.push(sourcePhrases.addBatch(sps.slice(sps.length - MAX_BATCH)));
                                        deferreds[deferreds.length - 1].done(function() {
                                            updateStatus(i18n.t("view.dscStatusSavingProgress", {number: deferreds.length, total: batchesSent}), Math.floor(deferreds.length / batchesSent * 100));
                                        });    
                                    }
                                    markers = ""; // reset
                                    filterIdx++;
                                }
                                if (filterIdx >= filterElts.length) {
                                    moreFilter = false; // done
                                }
                            }
                        }
                        
                    });
                    // add any remaining sourcephrases
                    if ((sps.length % MAX_BATCH) > 0) {
                        batchesSent++;
                        updateStatus(i18n.t("view.dscStatusSaving", {number: batchesSent, details: i18n.t("view.detailChapterVerse", {chap: chapterName, verse: verseCount})}), 0);
                        deferreds.push(sourcePhrases.addBatch(sps.slice(sps.length - (sps.length % MAX_BATCH))));
                        deferreds[deferreds.length - 1].done(function() {
                            updateStatus(i18n.t("view.dscStatusSavingProgress", {number: deferreds.length, total: batchesSent}), Math.floor(deferreds.length / batchesSent * 100));
                        });
                    }
                    // track all those deferred calls to addBatch -- when they all complete, report the results to the user
                    intervalID = window.setInterval(function() {
                        var result = checkState();
                        if (result === "pending") {
                            // pending -- do nothing
                        } else if (result === "resolved") {
                            // resolved
                            clearInterval(intervalID);
                            intervalID = 0;
                            importSuccess();
                        } else {
                            // rejected
                            clearInterval(intervalID);
                            intervalID = 0;
                            importFail(result);
                        }
                    }, 1000);
                    // update the last chapter's verseCount and last adapted verse
                    chapter.set('lastadapted', lastAdapted, {silent: true});
                    chapter.set('versecount', verseCount, {silent: true});
                    chapter.save();
                    if (isMergedDoc === true) {
                        var chapList = [];
                        var number = 0;
                        var tmpString = "";
                        // If this is a merged document, the chapters might be out of order -- 
                        // sort them here
                        for (i = 0; i < chaps.length; i++) {
                            tmpString = chapters.findWhere({chapterid: chaps[i]}).get("name");
                            number = parseInt(tmpString.substr(tmpString.lastIndexOf(" " + 1)), 10); // just the number part
                            chapList.push({chapid: chaps[i], number: number});
                        }
                        var result = Underscore.sortBy(chapList, function (element) {
                            return element.number;
                        });
                        // transfer the sorted list back into chaps
                        chaps.length = 0; // clear chaps
                        for (i = 0; i < result.length; i++) {
                            chaps.push(result[i].chapid);
                        }
                    }
                    book.set('chapters', chaps, {silent: true});
                    book.save();
                    return true; // success
                    // END readXMLDoc()
                };

                // Lexical data doc in SFM format
                // AIM 1.11.0 / issue #496: This is for pre-populating the KB with keywords using the \lx \ge syntax.
                // Notes:
                // 1. \lx and \ge markers are SFM, but not USFM -- they are an easy/quick way to add key terms to a KB
                //    (see https://github.com/adapt-it/adapt-it-mobile/issues/496 for a sample file)
                // 2. This method is the equivalent functionality as Adapt It Desktop's Import to Knowledge Base / Standard Format
                //    dialog option.
                var readSFMLexDoc = function (contents) {
                    var defer = $.Deferred(),
                        i = 0,
                        refstrings = [],
                        curDate = new Date(),
                        timestamp = (curDate.getFullYear() + "-" + (curDate.getMonth() + 1) + "-" + curDate.getDay() + "T" + curDate.getUTCHours() + ":" + curDate.getUTCMinutes() + ":" + curDate.getUTCSeconds() + "z"),
                        mn = 1,
                        f = "0",
                        bMerge = false;

                    console.log("readSFMLexDoc - entry");
                    // ** Sanity check: Is this a keyword document? 
                    i = contents.indexOf("\\lx ");
                    index = contents.indexOf("\\ge");
                    if ((1 === -1) || (index === -1)) {
                        // Need to have at least one \lx and one \ge for us to consider this file
                        console.log("No lexeme or definition found -- exiting");
                        errMsg = i18n.t("view.dscErrSFMLexNotFound");
                        return false;
                    }
                    // We're looking at a simple list of source/target pairs, with no indication of language
                    // (unlike a KB import) -- so we'll assume the file is okay in our project. So the only test
                    // we can make is to check for a non-empty the KB. If it's not empty, ask the user if they
                    // want to merge or overwrite the KB.
                    if (window.Application.kbList.length > 0 && window.Application.kbList.findWhere({isGloss: 0})) {
                        console.log("Import KB / not empty, object count: " + window.Application.kbList.length);
                        // KB NOT empty -- ask the user if they want to restore from this file or just merge with the KB in our DB
                        navigator.notification.confirm(i18n.t("view.dscRestoreOrMergeSFMLex", {document: bookName}), function (buttonIndex) {
                            switch (buttonIndex) {
                            case 1: 
                                // Restore
                                // Delete the existing KB
                                $.when(window.Application.kbList.clearKBForProject(project.get('projectid'), 0)).done(function() {
                                    window.Application.kbList.reset(); // clear the local list
                                    defer.resolve("Restore selected");
                                });
                                break;
                            case 2: 
                                // Merge
                                defer.resolve("Merge selected");
                                bMerge = true;
                                break;
                            case 3:
                            default: 
                                // User pressed Cancel on import - return to the main screen
                                if (window.history.length > 1) {
                                    // there actually is a history -- go back
                                    window.history.back();
                                } else {
                                    // no history (import link from outside app) -- just go home
                                    window.location.replace("");
                                }
                                return true; // success
                            }
                        }, i18n.t("view.ttlImportSFMLex"), [i18n.t("view.optRestore"), i18n.t("view.optMerge"), i18n.t("view.optCancelImport")]);
                    } else {
                        // KB is empty -- no need for prompt; just import
                        defer.resolve("new KB / no confirm needed, just importing");
                    }

                    defer.then(function (msg) {
                        isKB = true; // we're importing knowledge base data
                        var bFoundRS = false;
                        var theTU = null;
                        var theRS = null;
                        var tuCount = 0;
                        var rsCount = 0;
                        var mkr = 0;
                        var newTU = false;
                        var rs = "";
                        var src = "";
                        var projectid = project.get('projectid');
                        var RSidx = 0;
                        console.log(msg);
                        arr = contents.replace(/\\/gi, " \\").split(spaceRE); // add space to make sure markers get put in a separate token
                        arrSP = contents.replace(/\\/gi, " \\").split(nonSpaceRE); // add space to make sure markers get put in a separate token
                        i = 0;
                        while (i < arr.length) {
                            // check for a marker
                            if (arr[i].indexOf("\\") === 0) {
                                // marker found. What is it?
                                if (arr[i] === "\\lx") {
                                    tuCount++;
                                    mkr = LexMkrEnum.LX;
                                } else if (arr[i] === "\\ge") {
                                    rsCount++;
                                    mkr = LexMkrEnum.GE;
                                } else {
                                    // This isn't a SFM \lx \ge document (it supports ONLY those markers) -- error out
                                    errMsg = i18n.t("view.dscErrSFMLexBadMarker", {mkr: arr[i]});
                                    return false;
                                }
                                // Now get the string associated with the marker we collected
                                s = ""; // reset the string
                                i++;  // start from the next array slot
                                while (i < arr.length && arr[i].indexOf("\\") === -1) {
                                    // copy the text associated with the marker into the source
                                    s += arr[i] + " ";
                                    i++;
                                }
                                // now process the TU as appropriate
                                if (mkr === LexMkrEnum.LX) {
                                    // TU entry
                                    src = stripPunctuation(autoRemoveCaps(s.trim(), true), true);
                                    newTU = true;
                                    // save / clear previous values
                                    if (theTU) {
                                        theTU.save();
                                    }
                                    refstrings.length = 0; // clear out old refstrings array if needed
                                    // look up the TU (might return null if not found -- we'll deal with that case in the refstring block below)
                                    theTU = window.Application.kbList.findWhere([{source: src}, {projectid: projectid}, {isGloss: 0}]);
                                } else {
                                    // RefString (target) entry
                                    rs = stripPunctuation(autoRemoveCaps(s.trim(), false), false);
                                    // Are we merging with existing KB entries?
                                    if (bMerge === true) {
                                        if (theTU) {
                                            bFoundRS = false;
                                            // found a matching TU
                                            // Does our TU have this refstring?
                                            theRS = theTU.get("refstring");
                                            for (RSidx=0; RSidx<theRS.length; RSidx++) {
                                                if (rs === theRS[RSidx].target) {
                                                    // found the refstring -- add this refcount to the one in our KB
                                                    if (Number(theRS[RSidx].n) < 0) {
                                                        // special case -- this value was removed, but now we've got it again:
                                                        // reset the count to 1 in this case
                                                        theRS[RSidx].n = '1';
                                                    } else {
                                                        theRS[RSidx].n = String(Number(theRS[RSidx].n) + 1);
                                                    }
                                                    bFoundRS = true;
                                                    break; // done searching
                                                }
                                            }
                                            if (bFoundRS === false) {
                                                // refstring not found -- add a new one
                                                var newRS = {
                                                    'target': rs,  //klb
                                                    'n': '1',
                                                    'cDT': timestamp,
                                                    'df': '0',
                                                    'wC': ""
                                                };
                                                theRS.push(newRS);
                                                theTU.update();
                                            }
                                        } else {
                                            // TU not found -- create a new one from the file
                                            var newRS = {
                                                'target': rs,
                                                'n': '1',
                                                'cDT': timestamp,
                                                'df': '0',
                                                'wC': ""
                                            };
                                            refstrings.push(newRS);
                                            // now create the TU
                                            var newID = window.Application.generateUUID();
                                            var newTU = new kbModels.TargetUnit({
                                                tuid: newID,
                                                projectid: projectid,
                                                source: src,
                                                mn: mn,
                                                f: f,
                                                refstring: refstrings.splice(0, 1), // return 1 element array
                                                timestamp: timestamp,
                                                isGloss: 0
                                            });
                                            // add this TU to our internal list
                                            theTU = newTU;
                                        }
                                    } else {
                                        // no merge, just add
                                        if (theTU) {
                                            // existing TU -- add this refstring
                                            theRS = theTU.get("refstring");
                                            var newRS = {
                                                'target': rs,  //klb
                                                'n': '1',
                                                'cDT': timestamp,
                                                'df': '0',
                                                'wC': ""
                                            };
                                            theRS.push(newRS);
                                            // save our changes to this TU
                                            theTU.update();                                    
                                        } else {
                                            // new TU + new refstring
                                            var newRS = {
                                                'target': rs,
                                                'n': '1',
                                                'cDT': timestamp,
                                                'df': '0',
                                                'wC': ""
                                            };
                                            refstrings.push(newRS);
                                            // now create the TU
                                            var newID = window.Application.generateUUID();
                                            var newTU = new kbModels.TargetUnit({
                                                tuid: newID,
                                                projectid: projectid,
                                                source: src,
                                                mn: mn,
                                                f: f,
                                                refstring: refstrings.splice(0, 1), // return 1 element array
                                                timestamp: timestamp,
                                                isGloss: 0
                                            });
                                            // add this TU to our internal list
                                            theTU = newTU;
                                        }
                                    }
                                }                            
                            } else {
                                // skip anything else (including empty array elements)
                                i++;
                            }
                        }
                        // final TU obj save
                        if (theTU) {
                            theTU.save();
                        }
                        console.log("readSFMLexDoc -- tuCount: " + tuCount + ", rsCount: " + rsCount);
                        // Exit out with SUCCESS status                    
                        importSuccess();
                        return true; // success
                    });
                    // return true; // success
                    // END readSFMLexDoc()
                };
                
                // USFM document
                // This is the file format for Bibledit and Paratext
                // See http://paratext.org/about/usfm for format specification;
                // Currently supporting USFM v3.0 (see tag list in utils/usfm.js)
                var readUSFMDoc = function (contents) {
                    var scrIDList = new scrIDs.ScrIDCollection();
                    var chapterName = "";
                    var sp = null;
                    var markerList = new USFM.MarkerCollection();
                    var lastAdapted = 0;
                    var verseCount = 0;
                    var verseID = window.Application.generateUUID();
                    var firstBlock = true;
                    var i = 0;
                    var tmpIdx = 0;
                    var punctIdx = 0;
                    var contentsIdx = 0;
                    var chapNumber = 0;
                    var stridx = 0;
                    var verseNum = "";
                    var verseStartIdx = 0;
                    var verseEndIdx = 0;
                    var verseFound = false;
                    var chaps = [];
                    var mkr = null;
                    var tmpnorder = 0;
                    var strImportedVerse = "";
                    var strExistingVerse = "";
                    var encoding = "";
                    var spsExisting = null;
                    var bVIDFound = false;
                    var markerCache = "";
                    var defer = $.Deferred();

                    console.log("Reading USFM file:" + fileName);
                    // find the ID of this book:
                    // any USFM file MUST have an \id marker
                    index = contents.indexOf("\\id");
                    if (index === -1) {
                        // no ID found -- return
                        errMsg = i18n.t("view.dscErrCannotFindID");
                        return false;
                    }
                    markerList.fetch({reset: true, data: {name: ""}});
                    scrIDList.fetch({reset: true, data: {id: ""}});
                    scrID = scrIDList.where({id: contents.substr(index + 4, 3)})[0]; // our scripture ID
                    index = contents.indexOf("\\usfm");
                    if (index !== -1) {
                        // usfm version 3.0 or later, probably
                        versionSpec = contents.substring(index + 5, contents.indexOf(" ", index + 5));
                    }
                    // now try to build the book name
                    index = contents.indexOf("\\h ");
                    if (index > -1) {
                        // get the name from the usfm itself
                        bookName = contents.substr(index + 3, (contents.indexOf("\n", index) - (index + 3))).trim();
                        if (bookName.length === 0) {
                            // fall back on the file name
                            if (fileName.indexOf(".") > -1) {
                                // most likely has an extension -- remove it for our book name guess
                                bookName = fileName.substring(0, fileName.lastIndexOf('.'));
                            } else {
                                bookName = fileName;
                            }
                        }
                    } else {
                        if (fileName.indexOf(".") > -1) {
                            // most likely has an extension -- remove it for our book name guess
                            bookName = fileName.substring(0, fileName.lastIndexOf('.'));
                        } else {
                            // it's possible we're dealing with a clipboard USFM fragment.
                            if (fileName.indexOf(i18n.t("view.lblText") + "-") > -1) {
                                // This came from the clipboard. There's no \\h marker, but there is an \\id marker.
                                // Take the bookName from that
                                bookName = i18n.t("view." + scrID.get("id")); // localized ID book name (only our 6 locales for now)
                            } else {
                                bookName = fileName;
                            }
                        }
                    }
                    // check encoding -- we only support UTF-8 (default for USFM), due to
                    // sqlite API calls to open the AIM database. 
                    index = contents.indexOf("\\ide");
                    if (index !== -1) {
                        // encoding is specified -- what is it?
                        encoding = contents.substring(index + 5, contents.indexOf("\n", index + 5)).trim();
                        // special case -- an older AIM export with a missing \\ide value
                        if (encoding === "") {
                            // this is really UTF-8, but let's make it explicit
                            contents.replace("\\ide ", "\\ide UTF-8 ");
                            encoding = "UTF-8"; 
                        }
                        // okay, check the encoding
                        if (encoding !== "UTF-8") { // nope -- error out
                            errMsg = i18n.t("view.dscErrUnsupportedEncoding");
                            return false;
                        }
                    }
                    var entries = books.where({scrid: (scrID.get('id'))});
                    var numChaps = scrID.get("chapters").length;
                    if (entries.length > 0) {
                        // Existing doc -- 
                        // First update our book name (the one we have might have come from the clipboard or filename, OR
                        // the user might have changed it after the last import)
                        book = entries[0];
                        bookName = book.get("name");
                        // load up the sourcephrases for this book, then ask the user what they want to do
                        // (cancel or use the imported doc / override any conflicts with the imported version)
                        var args = book.get("chapters"); //.join(", ");                                    
                        $.when(sourcePhrases.fetch({data: {chapterid: args}})).then( function (a) {
                            console.log("Fetch: " + a);
                            navigator.notification.confirm(i18n.t("view.ttlDupImport", {document: bookName}), function (buttonIndex) {
                                if (buttonIndex === 1) {
                                    defer.reject("cancel import (duplicate document)"); // handled in the defer.reject() block at the end of readUSFMDoc() below
                                } else {
                                    // Override
                                    bOverride = true;
                                    // User decided to import / override any existing content -- 
                                    // use this book object instead of creating a new one
                                    book = entries[0];
                                    // verify that the chapters have been created (this is for pre-1.6.0 imports)
                                    if (numChaps !== book.get('chapters').length) {
                                        // create empty chapters (i.e. with no verses) that are missing in our book
                                        // NOTE that the chapter objects are saved at the end of the USFM import
                                        for (i=book.get('chapters').length; i < numChaps; i++) {
                                            chapterName = i18n.t("view.lblChapterName", {bookName: bookName, chapterNumber: (i + 1)});
                                            // does this chapter name exist?
                                            if (!chapters.where({name: chapterName})[0]) {
                                                // chapter doesn't exist -- create it now
                                                chapterID = window.Application.generateUUID();
                                                chaps.push(chapterID);
                                                chapter = new chapModel.Chapter({
                                                    chapterid: chapterID,
                                                    bookid: bookID,
                                                    projectid: project.get('projectid'),
                                                    name: chapterName,
                                                    lastadapted: 0,
                                                    versecount: 0
                                                });
                                                chapters.add(chapter);
                                            }
                                        }
                                        // update the book chapter array
                                        book.set('chapters', chaps, {silent: true});
                                        book.save();                
                                    }
                                    // Check to see if we're importing content that DOES NOT INCLUDE chapter 1
                                    // (in this case we'll be splicing together a Key It file from a chapter > 1, 
                                    // so we'll want to avoid importing the \\id marker twice -- it's supposed 
                                    // to be unique in the file)
                                    if ((contents.indexOf("\\c 1 ") === -1) && (contents.indexOf("\\c 1\n") === -1)) {
                                        // importing a chapter other than chapter #1 (Key It file) --
                                        // first, find the first \\c position in the contents
                                        index = contents.indexOf("\\c ");
                                        // skip if there is no \c marker at all (e.g., an appendix of some sort)
                                        if (index > 0) {
                                            // remove everything before this point
                                            contents = contents.replace(contents.substring(0, index - 1), "");
                                        }
                                    }
                                    // finished -- return
                                    defer.resolve("confirm override");                        
                                }
                            },
                            'Warning',           // title
                            [i18n.t("view.optCancelImport"),i18n.t("view.optUpdateImport", {document: bookName})]     // buttonLabels
                        )});                        
                    } else {
                        // new import -- create the book object, with all the chapter objects 
                        // (with zero verses for now; they are populated below)
                        // NOTE that the chapter objects are saved at the end of the USFM import
                        bookID = window.Application.generateUUID();
                        book = new bookModel.Book({
                            bookid: bookID,
                            projectid: project.get('projectid'),
                            scrid: scrID.get('id'),
                            name: bookName,
                            filename: fileName,
                            chapters: [] // arr -- updated after we add the chapters
                        });
                        books.add(book);
                        for (i=0; i < numChaps; i++) {
                            chapterID = window.Application.generateUUID();
                            chaps.push(chapterID);
                            chapterName = i18n.t("view.lblChapterName", {bookName: bookName, chapterNumber: (i + 1)});
                            chapter = new chapModel.Chapter({
                                chapterid: chapterID,
                                bookid: bookID,
                                projectid: project.get('projectid'),
                                name: chapterName,
                                lastadapted: 0,
                                versecount: 0
                            });
                            chapters.add(chapter);
                        }
                        // update the chapters in our book
                        book.set('chapters', chaps, {silent: true});
                        book.save();
                        // Check to see if we're importing content that DOES NOT INCLUDE chapter 1
                        // (in this case we'll be splicing together a Key It file from a chapter > 1, 
                        // so we'll want to avoid importing the \\id marker twice -- it's supposed 
                        // to be unique in the file)
                        if ((contents.indexOf("\\c 1 ") === -1) && (contents.indexOf("\\c 1\n") === -1)) {
                            // importing a chapter other than chapter #1 (Key It file) --
                            // first, find the first \\c position in the contents
                            index = contents.indexOf("\\c ");
                            // skip if there is no \c marker at all (e.g., an appendix of some sort)
                            if (index > 0) {
                                // remove everything before this point
                                contents = contents.replace(contents.substring(0, index - 1), "");
                            }
                        }
                        // resolve -- don't need to add a confirm dialog
                        defer.resolve("new import / no confirm needed");
                    }

                    // edb 4 Feb 2022 -- processing requires a possible pause to confirm the override; we'll wait on the
                    // callback results and then continue the import or exit (if the user cancels).
                    defer.then(function (msg) {
                        console.log(msg);
                        // Continue processing the file. Note that at this point, the book and all chapters
                        // have been created for this file (either newly created or merged with an existing one)

                        // reset the objects to the beginning of this book (chapter 1)
                        chapterID = book.get("chapters")[0]; // first chapter of the current book (UUID string)
                        chapter = chapters.where({chapterid: chapterID})[0]; // chapter object from chapters list
                        if (typeof(chapter) === "undefined" || chapter === null) {
                            // Ugh. Can't find the chapter in the list. This _might_ mean that we had a corruption
                            // when deleting a chapter / book earlier -- error out.
                            errMsg = i18n.t("view.dscErrMergeNoChapID", {chapter: chapterID});
                            importFail(new Error(errMsg));
                        }
                        chapterName = chapter.get("name");
                        // get the existing source phrases in this chapter (empty if this is a new import)
                        spsExisting = sourcePhrases.where({chapterid: chapterID}); 
                        console.log("Existing sourcephrases for chapter: " + sourcePhrases.length);
                        firstBlock = true;
                        if (spsExisting.length > 0) {
                            // set norder (and verseID) to the first item in our existing list
                            norder = spsExisting[0].get("norder");
                            verseID = spsExisting[0].get("vid");
                        } else {
                            // no sourcephrases in the first chapter -- set the verse ID to a UUID
                            verseID = window.Application.generateUUID(); // initial value -- chunk before verse 1 is considered a new "verse"
                        }
                        var tmpID = null;
                        var tmpObj = null;
                        var tmpMk = "";
                        var num = /\d/;
                        var strContentsNoCRLF = "";
                        var phIdx = 0; // track the beginning index of markers as we go
                        if (bOverride === true) {
                            strContentsNoCRLF = contents.replace(CRLF_RE, " ");
                        }

                        // build SourcePhrases
                        arr = contents.replace(/\\/gi, " \\").split(spaceRE); // add space to make sure markers get put in a separate token
                        arrSP = contents.replace(/\\/gi, " \\").split(nonSpaceRE); // add space to make sure markers get put in a separate token
                        i = 0;
                        while (i < arr.length) {
                            // check for a marker
                            if (arr[i].length === 0) {
                                // nothing in this token -- skip
                                i++;
                            } else if (arr[i].indexOf("\\") === 0) {
                                if (phIdx === 0) {
                                    phIdx = i; // new 
                                }
                                // marker token
                                if (markers.length > 0) {
                                    markers += " ";
                                }
                                markers += arr[i];
                                // console.log("Marker found: " + markers);
                                // If this is the start of a new paragraph, etc., check to see if there's a "dangling"
                                // punctuation mark. If so, it belongs as a follPunct of the precious SourcePhrase
                                if ((arr[i] === "\\p" || arr[i] === "\\c" || arr[i] === "\\v") && prepuncts.length > 0) {
                                    sp.set("follpuncts", (sp.get("follpuncts") + prepuncts), {silent: true});
                                    prepuncts = ""; // clear out the punctuation -- it's set on the previous sp now
                                }
                                // default from AI desktop -- set end Free Translation bit to the last SP before a new verse
                                if (arr[i] === "\\v") {
                                    // if there's a previous sp, set the flags
                                    // (special case -- for pre-verse1 data that gets merged, there's no previous sourcephrase defined)
                                    if (sp !== null) {
                                        sp.set("flags", END_FT_BIT, {silent: true});
                                    }
                                }
                                mkr = markerList.where({name: arr[i].substr(arr[i].indexOf("\\") + 1)});
                                if (mkr.length > 0 && mkr[0].get("endMarker")) {
                                    // this needs an end marker -- take the entire filter up to the end marker
                                    // and create a single sourcephrase out of it
                                    s = "";
                                    i++;  // don't copy the marker into the source
                                    var strEndMkr = mkr[0].get("endMarker"); 
                                    while (i < arr.length && arr[i].indexOf(mkr[0].get("endMarker")) === -1) {
                                        // copy the text associated with the marker into the source
                                        s += " " + arr[i];
                                        i++;
                                    }
                                    // source contains the entire string; markers contains the marker that caused it
                                    spID = window.Application.generateUUID();
                                    if (markers.indexOf("\\v ") !== -1) {
                                        // case where a marker with an end marker (e.g., a cross-reference) follows a
                                        // verse -- need to get a new verse ID
                                        verseID = window.Application.generateUUID();
                                        var vCount = (markers.match(/\\v /g) || []).length;
                                        var realCount = vCount;
                                        var vIdx = 0;
                                        var aRange = [];
                                        // Each \v marker can be followed by a _range_ of verses (e.g. "\v 1-3") or a single verse.
                                        // Figure out how much we should increment the verseCount by
                                        for (var idx=0; idx<vCount; idx++) {
                                            vIdx = markers.indexOf("\\v ", vIdx) + 3;
                                            if (markers.lastIndexOf(" ") < vIdx) {
                                                // no space after the chapter # (it's the ending of the string)
                                                verseNum = markers.substr(vIdx);
                                            } else {
                                                // space after the chapter #
                                                verseNum = markers.substr(vIdx, markers.indexOf(" ", vIdx) - vIdx);
                                            }
                                            if (verseNum.indexOf("-") > -1) { 
                                                // this is a range - count the # of verses
                                                aRange = verseNum.split("-");
                                                realCount += (parseInt(aRange[1],10) - parseInt(aRange[0],10));
                                            }                                
                                        }
                                        if (realCount !== vCount) {
                                            console.log("Found at least 1 range of verses. vCount=" + vCount + ", computed realCount=" + realCount);
                                        }
                                        verseCount = verseCount + realCount;
                                        // ** MERGE case: verse combined with an end marker
                                        if (spsExisting.length > 0) {
                                            // we have some existing sourcephrases for this chapter -- see if this verse needs merging
                                            // get the verse # (string -- we'll be looking in the sourcephrase markers)
                                            strExistingVerse = ""; // clear out any old verse info
                                            stridx = markers.indexOf("\\v ") + 3;
                                            if (markers.lastIndexOf(" ") < stridx) {
                                                // no space after the chapter # (it's the ending of the string)
                                                verseNum = "\\v " + markers.substr(stridx);
                                            } else {
                                                // space after the chapter #
                                                verseNum = "\\v " + markers.substr(stridx, markers.indexOf(" ", stridx) - stridx);
                                            }
                                            // find the verse number in the spsExisting list's markers
                                            for (tmpIdx=0; tmpIdx<spsExisting.length; tmpIdx++) {
                                                tmpMk = spsExisting[tmpIdx].get("markers");
                                                // test for the exact verse number (e.g., "v 1" but not "v 10")
                                                if ((tmpMk.indexOf(verseNum) > -1) && (num.test(tmpMk.charAt(tmpMk.indexOf(verseNum) + verseNum.length)) === false)) {
                                                    verseFound = true;
                                                    // keep track of the norder and verseID -- we'll use them below
                                                    tmpnorder = spsExisting[tmpIdx].get("norder");
                                                    verseID = spsExisting[tmpIdx].get("vid");
                                                    break; // exit the for loop
                                                }
                                            }
                                            // did we find the verse?
                                            if (verseFound === true) {
                                                console.log("Merging verse w/end marker: ("+ strEndMkr + ") " + spsExisting[tmpIdx].get("markers") + ", " + verseID);
                                                verseFound = false; // clear the flag
                                                // verse needs merging -- compare the DB to what we're importing
                                                // reconstitute the verse in the DB
                                                bVIDFound = false;
                                                markerCache = "";
                                                for (tmpIdx=0; tmpIdx<spsExisting.length; tmpIdx++) {
                                                    // as we work through the ordered spsExisting array to build strExistingVerse, also pull out the
                                                    // equivalent indices in the imported contents string so we can build strImportedVerse
                                                    if (spsExisting[tmpIdx].get("vid") === verseID) {
                                                        if (bVIDFound === false) {
                                                            // First sourcephrase within the verse:
                                                            bVIDFound = true;
                                                            // this is the start of the verse in the db - pull out the markers and find where they
                                                            // occur in the imported contents string; this will be our start for the strImportedVerse
                                                            if (strContentsNoCRLF.indexOf(spsExisting[tmpIdx].get("markers")) > -1) {
                                                                verseStartIdx = strContentsNoCRLF.indexOf(spsExisting[tmpIdx].get("markers"));
                                                            }
                                                            // concatenate strExistingVerse (markers + source), then add the ending marker
                                                            tmpMarkers = spsExisting[tmpIdx].get("markers");
                                                            if (tmpMarkers.length > 0) {
                                                                // now add the markers and a space
                                                                strExistingVerse += tmpMarkers + " ";
                                                            }
                                                            strExistingVerse += spsExisting[tmpIdx].get("source"); // no space (ending marker goes right after)
                                                            // ending marker
                                                            strExistingVerse += "\\" + strEndMkr + " ";
                                                            strEndMkr = ""; // clear out
                                                        } else {
                                                            // subsequent sourcephrases within the verse:
                                                            // just concatenate strExistingVerse (markers + source)
                                                            tmpMarkers = spsExisting[tmpIdx].get("markers");
                                                            if (tmpMarkers.length > 0) {
                                                                // now add the markers and a space
                                                                strExistingVerse += tmpMarkers + " ";
                                                            }
                                                            strExistingVerse += spsExisting[tmpIdx].get("source") + " ";
                                                        }

                                                    } else if (bVIDFound === true) {
                                                        // this is the start of the verse _after_ verseID - pull out the markers and find where they
                                                        // occur in the imported contents string; this will be our ENDING for the strImportedVerse
                                                        markerCache = spsExisting[tmpIdx].get("markers"); // save the next verse's markers
                                                        bVIDFound = false; // reset the flag
                                                        break; // done building strExistingVerse -- exit the for loop
                                                    }
                                                }
                                                // build the imported verse
                                                // Ending index
                                                if (contents.indexOf("\\v ", contents.indexOf(verseNum) + 2) > 0) {
                                                    // not the last verse in the imported contents -- 
                                                    // the ending index could have some markers before the next verse (e.g., "\p \v nnn")
                                                    if (markerCache.length > 0) {
                                                        // markers before the next verse
                                                        verseEndIdx = strContentsNoCRLF.indexOf(markerCache, verseStartIdx); // up to, but not including the next verse's markers
                                                        markerCache = ""; // clear out the cached value
                                                    } else {
                                                        // no markers -- could be the last verse in the chapter
                                                        if (bVIDFound === true) {
                                                            // last verse in chapter
                                                            console.log("merge verse - end of chapter");
                                                            if (contents.indexOf("\\c ", verseStartIdx) > 0) {
                                                                verseEndIdx = contents.indexOf("\\c", verseStartIdx);
                                                            }
                                                        } else if (strExistingVerse !== "") {
                                                            // we have existing data for this verse, but no markers (shouldn't happen)
                                                            console.log("merge verse - found a verse missing markers");
                                                            verseEndIdx = contents.indexOf("\\v ", contents.indexOf(verseNum) + 2); // sanity check (shouldn't happen)                                                            
                                                        }
                                                    }
                                                } else {
                                                    verseEndIdx = contents.length - 1; // last verse
                                                }
                                                // now clip out the imported verse and normalize CRLF and spaces
                                                strImportedVerse = contents.substring(verseStartIdx, verseEndIdx);
                                                strImportedVerse = strImportedVerse.replace(CRLF_RE, " "); // remove CRLF chars
                                                strImportedVerse = strImportedVerse.replace(GspaceRE, " "); // single spaces only
                                                // done! Does it match what's in the DB?
                                                if (strImportedVerse.trim() !== strExistingVerse.replace(GspaceRE, " ").trim()) {
                                                    console.log("verses differ: " + verseID);
                                                    // verses differ -- 
                                                    // Move [i] back to the beginning of the verse, and delete what we have in the DB.
                                                    if (phIdx !== 0) {
                                                        i = phIdx;
                                                        phIdx = 0; // reset
                                                    }
                                                    var tmpStart = -1;
                                                    var tmpLength = 0;
                                                    // Now delete the existing sourcephrases from the DB (we'll import below)
                                                    for (tmpIdx=0; tmpIdx<spsExisting.length; tmpIdx++) {
                                                        if (spsExisting[tmpIdx].get("vid") === verseID) {
                                                            // delete this guy
                                                            tmpID = spsExisting[tmpIdx].get("spid");
                                                            tmpObj = sourcePhrases.findWhere({spid: tmpID});
                                                            sourcePhrases.remove(tmpObj);
                                                            tmpObj.destroy();
                                                            if (tmpStart === -1) {
                                                                tmpStart = tmpIdx;
                                                            }
                                                            tmpLength++;
                                                        }
                                                    }
                                                    // also clean out spsExisting
                                                    spsExisting.splice(tmpStart, tmpLength);
                                                    // place the imported data where the existing verse used to be
                                                    norder = (tmpnorder - 100);
                                                    markers = ""; // clear out the markers so we rebuild it correctly
                                                    continue; // jump to while loop
                                                } else {
                                                    console.log("verses SAME: " + verseID);
                                                    // Merging an existing chapter/verse, but the verse is the same --
                                                    // move our import index to the next verse / chapter position
                                                    while (i < arr.length) {
                                                        // stop at next verse or chapter
                                                        if ((arr[i] === "\\v") || (arr[i] === "\\c")) {
                                                            break;
                                                        }
                                                        // stop if we've reached the markers for the next verse
                                                        if ((arr[i].length > 0) && (markerCache.length > 0) && (markerCache.indexOf(arr[i]) !== -1)) {
                                                            break;
                                                        }
                                                        i++;
                                                    }
                                                    markers = ""; // clear out the markers for this verse
                                                    phIdx = 0; // clear phIdx
                                                    continue; // jump to while loop
                                                }
                                            } else {
                                                verseID = window.Application.generateUUID(); // not an existing verse -- create a new verse ID
                                                norder += 100;
                                            } 
                                        } else {
                                            verseID = window.Application.generateUUID(); // new verse in a new chapter -- create a new verse ID
                                            norder += 100;
                                        }
                                    }
                                    sp = new spModel.SourcePhrase({
                                        spid: spID,
                                        norder: norder,
                                        chapterid: chapterID,
                                        vid: verseID,
                                        markers: markers,
                                        orig: null,
                                        prepuncts: prepuncts,
                                        midpuncts: midpuncts,
                                        follpuncts: follpuncts,
                                        source: s,
                                        target: ""
                                    });
                                    markers = "";
                                    prepuncts = "";
                                    follpuncts = "";
                                    punctIdx = 0;
                                    index++;
                                    norder++;
                                    sps.push(sp);
                                    phIdx = 0; // reset
                                    // if necessary, send the next batch of SourcePhrase INSERT transactions
                                    if ((sps.length % MAX_BATCH) === 0) {
                                        batchesSent++;
                                        updateStatus(i18n.t("view.dscStatusSaving", {number: batchesSent, details: i18n.t("view.detailChapterVerse", {chap: chapterName, verse: verseCount})}), 0);
                                        deferreds.push(sourcePhrases.addBatch(sps.slice(sps.length - MAX_BATCH)));
                                        deferreds[deferreds.length - 1].done(function() {
                                            updateStatus(i18n.t("view.dscStatusSavingProgress", {number: deferreds.length, total: batchesSent}), Math.floor(deferreds.length / batchesSent * 100));
                                        });    
                                    }
                                } else if ((arr[i] === "\\c") || (arr[i] === "\\ca") || (arr[i] === "\\cp") ||
                                        (arr[i] === "\\v") || (arr[i] === "\\va") || (arr[i] === "\\vp")) {
                                    // Markers with more than one token -- 
                                    // join with the next token
                                    i++;
                                    markers += " " + arr[i];
                                }
                                i++;
                                // end marker token
                            } else if (arr[i].length === 1 && puncts.indexOf(arr[i]) > -1) {
                                // punctuation token -- add to the prepuncts
                                prepuncts += arr[i];
                                i++;
                            } else if (arr[i].length === 2 && puncts.indexOf(arr[i]) > -1) {
                                // 2-char punctuation token -- add to the prepuncts
                                prepuncts += arr[i];
                                i++;
                            } else {
                                // "normal" sourcephrase token
                                // Chapter element -- set the chapter ID to the one we created earlier
                                if (markers && markers.indexOf("\\c ") !== -1) {
                                    // If we actually had some content in our previous chapter, we can set the lastAdaptedXXX values
                                    // if they aren't already set
                                    if (verseCount > 0) {
                                        // set the current bookmark if not already set
                                        if (window.Application.currentBookmark === null) {
                                            console.log("readUSFMDoc() - creating bookmark");
                                            var bookmarkid = window.Application.generateUUID();
                                            var newBookmark = new userModels.Bookmark({
                                                bookmarkid: bookmarkid,
                                                projectid: project.get('projectid'),
                                                name: chapterName,
                                                bookid: bookID,
                                                chapterid: chapterID // note: no spID set (will start at beginning)
                                            });
                                            // save and add to the collection
                                            newBookmark.save();
                                            window.Application.bookmarkList.add(newBookmark);
                                            window.Application.currentBookmark = newBookmark;
                                        } else if (window.Application.currentBookmark.get('bookid').length === 0) {
                                            console.log("readUSFMDoc() - updating bookmark for book: " + bookName);
                                            // project is set, but the book / chapter values are not set -- set them now
                                            window.Application.currentBookmark.set("name", chapterName, {silent: true});
                                            window.Application.currentBookmark.set("bookid", bookID, {silent: true});
                                            window.Application.currentBookmark.set("chapterid", chapterID, {silent: true});
                                            window.Application.currentBookmark.update();
                                        }
                                    }
                                    // update the last adapted for the previous chapter before closing it out
                                    if (chapter.get('versecount') < verseCount) {
                                        // only update if we're increasing the verse count
                                        chapter.set('versecount', verseCount, {silent: true});
                                    }
                                    verseCount = 0; // reset for the next chapter
                                    lastAdapted = 0; // reset for the next chapter
                                    verseID = window.Application.generateUUID(); // initial value -- chunk before verse 1 is considered a new "verse"
                                    firstBlock = true; // first block in the chapter (for merging)
                                    stridx = markers.indexOf("\\c ") + 3;
                                    if (markers.lastIndexOf(" ") < stridx) {
                                        // no space after the chapter # (it's the ending of the string)
                                        chapNumber = markers.substr(stridx);
                                    } else {
                                        // space after the chapter #
                                        chapNumber = markers.substr(stridx, markers.indexOf(" ", stridx) - stridx);
                                    }
                                    chapterName = i18n.t("view.lblChapterName", {bookName: bookName, chapterNumber: chapNumber});
                                    contentsIdx = contents.indexOf(("\\c " + chapNumber), contentsIdx); // for first block processing
                                    // find the chapter in our list
                                    chapter = chapters.where({name: chapterName})[0];
                                    chapterID = chapter.get("chapterid");
                                    spsExisting = sourcePhrases.where({chapterid: chapterID}); // existing source phrases in this chapter (might be empty)
                                    console.log(chapterName + ": " + chapterID + "(" + spsExisting.length + " sourcephrases)");
                                    if (spsExisting.length > 0) {
                                        // check to see if the source phrase in this chapter have verse IDs assigned
                                        if (spsExisting[spsExisting.length - 1].get("vid").length === 0) {
                                            // no verse IDs assigned (this is a pre-1.6 import) -
                                            // assign verse IDs to each source phrase
                                            for (tmpIdx=0; tmpIdx<spsExisting.length; tmpIdx++) {
                                                if (spsExisting[tmpIdx].get("markers").indexOf("\\v") !== -1) {
                                                    verseID = window.Application.generateUUID(); // new verse -- create a new ID
                                                }
                                                spsExisting[tmpIdx].set('vid', verseID, {silent: true});
                                                spsExisting[tmpIdx].save();
                                            }
                                        }
                                        // get the verseID
                                        verseID = "";
                                        for (tmpIdx=0; tmpIdx<spsExisting.length; tmpIdx++) {
                                            if (spsExisting[tmpIdx].get("markers").indexOf("\\c") !== -1) {
                                                verseID = spsExisting[tmpIdx].get("vid");
                                                break; 
                                            }
                                        }
                                        // First block in new chapter -- rebuild strExistingVerse for the text up to the verse
                                        strExistingVerse = "";
                                        bVIDFound = false;
                                        markerCache = "";
                                        for (tmpIdx=0; tmpIdx<spsExisting.length; tmpIdx++) {
                                            // as we work through the ordered spsExisting array to build strExistingVerse, also pull out the
                                            // equivalent indices in the imported contents string so we can build strImportedVerse
                                            if (spsExisting[tmpIdx].get("vid") === verseID) {
                                                if (bVIDFound === false) {
                                                    bVIDFound = true; // found the verse
                                                }
                                                // concatenate strExistingVerse (markers + source)
                                                tmpMarkers = spsExisting[tmpIdx].get("markers");
                                                if (tmpMarkers.length > 0) {
                                                    // now add the markers and a space
                                                    strExistingVerse += tmpMarkers + " ";
                                                }
                                                strExistingVerse += spsExisting[tmpIdx].get("source") + " ";
                                            } else if (bVIDFound === true) {
                                                // this is the start of the verse _after_ verseID - pull out the markers and find where they
                                                // occur in the imported contents string; this will be our ENDING for the strImportedVerse
                                                markerCache = spsExisting[tmpIdx].get("markers"); // save the next verse's markers
                                                bVIDFound = false; // reset the flag
                                                break; // done building strExistingVerse -- exit the for loop
                                            }
                                        }
                                    }
                                }
                                if (spsExisting.length > 0 && firstBlock === true) {
                                    // special case for merging -- up to the first verse should be treated as one block for comparison
                                    // (could be the whole "chapter" if we're looking at front matter with no verse marker)
                                    // find the whole string to compare
                                    var chapIdx = contents.indexOf("\\c ", contentsIdx);
                                    var verseIdx = contents.indexOf("\\v ", contentsIdx + 2);
                                    var tmpMarkers = "";
                                    tmpnorder = 0; // reset tmpnorder (first block)
                                    if ((chapIdx === -1) && (verseIdx === -1)) {
                                        // last block -- use entire string
                                        strImportedVerse = contents.substring(contentsIdx, contents.length - 1);                                        
                                    } else {
                                        if (chapIdx === contentsIdx) {
                                            // \c starts the string -- go from there to the first verse in the chapter MINUS the markers
                                            // in markerCache
                                            if (markerCache.length > 0) {
                                                var endingIdx = strContentsNoCRLF.indexOf(markerCache, contentsIdx);
                                                if (endingIdx !== -1) {
                                                    strImportedVerse = contents.substring(contentsIdx, endingIdx);
                                                } else {
                                                    // markerCache not found
                                                    strImportedVerse = contents.substring(contentsIdx, verseIdx);
                                                }
                                            } else {
                                                // no markerCache -- go to the first verse
                                                strImportedVerse = contents.substring(contentsIdx, verseIdx);
                                            }
                                            // move verseStartIdx to the \\c
                                            verseStartIdx = contentsIdx;
                                        } else if ((chapIdx > verseIdx) || (chapIdx === -1)) {
                                            // either there's a verse first OR there are no more chapters -- 
                                            // either way, we want the string up to the verse
                                            strImportedVerse = contents.substring(contentsIdx, verseIdx);
                                            verseStartIdx = verseIdx;
                                        } else {
                                            // take the string up to the chapter
                                            strImportedVerse = contents.substring(contentsIdx, chapIdx);
                                            verseStartIdx = chapIdx;
                                        }
                                    }
                                    // now normalize CRLF and spaces
                                    strImportedVerse = strImportedVerse.replace(CRLF_RE, " "); // remove CRLF chars
                                    strImportedVerse = strImportedVerse.replace(GspaceRE, " "); // single spaces only
                                    // compare the imported block to what we have in the DB
                                    // reconstitute the verse in the DB
                                    strExistingVerse = "";
                                    for (tmpIdx=0; tmpIdx<spsExisting.length; tmpIdx++) {
                                        // Note that verseID is set to a unique value even for non-verse data (like here)
                                        if (spsExisting[tmpIdx].get("vid") === verseID) {
                                            // concatenate
                                            // add markers, and if needed, pretty-print the text on a newline
                                            tmpMarkers = spsExisting[tmpIdx].get("markers");
                                            if (tmpMarkers.length > 0) {
                                                // add the markers and a space
                                                strExistingVerse += tmpMarkers + " ";
                                            }
                                            strExistingVerse += spsExisting[tmpIdx].get("source") + " ";
                                        } 
                                    }
                                    if (strImportedVerse.trim() !== strExistingVerse.replace(GspaceRE, " ").trim()) {
                                        console.log("first block merge verses differ: " + verseID);
                                        // blocks differ -- 
                                        // Move [i] back to the beginning of the verse, and delete what we have in the DB.
                                        if (phIdx !== 0) {
                                            i = phIdx;
                                            phIdx = 0; // reset
                                        }
                                        // delete the existing sourcephrases from the DB (we'll import below)
                                        var tmpStart = -1;
                                        var tmpLength = 0;
                                        for (tmpIdx=0; tmpIdx<spsExisting.length; tmpIdx++) {
                                            if (spsExisting[tmpIdx].get("vid") === verseID) {
                                                // delete this guy
                                                tmpID = spsExisting[tmpIdx].get("spid");
                                                tmpObj = sourcePhrases.findWhere({spid: tmpID});
                                                sourcePhrases.remove(tmpObj);
                                                tmpObj.destroy();
                                                if (tmpStart === -1) {
                                                    tmpStart = tmpIdx;
                                                }
                                                tmpLength++;
                                            }
                                        }
                                        // also clean out spsExisting
                                        spsExisting.splice(tmpStart, tmpLength);
                                        // place the imported data where the existing verse used to be
                                        norder = tmpnorder;
                                        firstBlock = false; // done processing content before the first \\v in a chapter    
                                        // NO continue -- drop to next block and import this verse                            
                                    } else {
                                        console.log("first block merge verses same: " + verseID);
                                        // Merging an existing chapter/verse, but the verse is the same --
                                        // move our import index to the next position
                                        while (i < arr.length) {
                                            // stop at next verse or chapter
                                            if ((arr[i] === "\\v") || (arr[i] === "\\c")) {
                                                break;
                                            }
                                            // stop if we've reached the markers for the next verse
                                            if ((arr[i].length > 0) && (markerCache.length > 0) && (markerCache.indexOf(arr[i]) !== -1)) {
                                                break;
                                            }
                                            i++;
                                        }
                                        markers = ""; // clear out the markers for this verse
                                        markerCache = "";
                                        firstBlock = false; // done processing content before the first \\v in a chapter
                                        phIdx = 0; // clear phIdx
                                        // jump to while loop
                                        continue;
                                    }    
                                }
                                // also do some processing for verse markers
                                if (markers && markers.indexOf("\\v ") !== -1) {
                                    if (spsExisting.length > 0) {
                                        // we have some existing sourcephrases for this chapter -- see if this verse needs merging
                                        // get the verse # (string -- we'll be looking in the sourcephrase markers)
                                        strExistingVerse = ""; // clear out any old verse info
                                        stridx = markers.indexOf("\\v ") + 3;
                                        if (markers.lastIndexOf(" ") < stridx) {
                                            // no space after the chapter # (it's the ending of the string)
                                            verseNum = "\\v " + markers.substr(stridx);
                                        } else {
                                            // space after the chapter #
                                            verseNum = "\\v " + markers.substr(stridx, markers.indexOf(" ", stridx) - stridx);
                                        }
                                        // find the verse number in the spsExisting list's markers
                                        for (tmpIdx=0; tmpIdx<spsExisting.length; tmpIdx++) {
                                            tmpMk = spsExisting[tmpIdx].get("markers");
                                            // test for the exact verse number (e.g., "v 1" but not "v 10")
                                            if ((tmpMk.indexOf(verseNum) > -1) && (num.test(tmpMk.charAt(tmpMk.indexOf(verseNum) + verseNum.length)) === false)) {
                                                verseFound = true;
                                                // keep track of the norder and verseID -- we'll use them below
                                                tmpnorder = spsExisting[tmpIdx].get("norder");
                                                verseID = spsExisting[tmpIdx].get("vid");
                                                break; // exit the for loop
                                            }
                                        }
                                        // did we find the verse?
                                        if (verseFound === true) {
                                            console.log("Merging verse: " + spsExisting[tmpIdx].get("markers") + ", " + verseID);
                                            verseFound = false; // clear the flag
                                            // verse needs merging -- compare the DB to what we're importing
                                            // reconstitute the verse in the DB
                                            bVIDFound = false;
                                            markerCache = "";
                                            for (tmpIdx=0; tmpIdx<spsExisting.length; tmpIdx++) {
                                                if (spsExisting[tmpIdx].get("vid") === verseID) {
                                                    if (bVIDFound === false) {
                                                        bVIDFound = true;
                                                        if (strContentsNoCRLF.indexOf(spsExisting[tmpIdx].get("markers"), verseStartIdx) > -1) {
                                                            verseStartIdx = strContentsNoCRLF.indexOf(spsExisting[tmpIdx].get("markers"), verseStartIdx);
                                                        }
                                                    }
                                                    // concatenate (markers + source)
                                                    tmpMarkers = spsExisting[tmpIdx].get("markers");
                                                    if (tmpMarkers.length > 0) {
                                                        // now add the markers and a space
                                                        strExistingVerse += tmpMarkers + " ";
                                                    }
                                                    strExistingVerse += spsExisting[tmpIdx].get("source") + " ";
                                                } else if (bVIDFound === true) {
                                                    markerCache = spsExisting[tmpIdx].get("markers"); // save the next verse's markers
                                                    bVIDFound = false; // reset the flag
                                                    break; // done building strExistingVerse -- exit the for loop
                                                }
                                            }
                                            //
                                            if (contents.indexOf("\\v ", contents.indexOf(verseNum) + 2) > 0) {
                                                // not the last verse in the imported contents -- 
                                                // the ending index could have some markers before the next verse (e.g., "\p \v nnn")
                                                if (markerCache.length > 0) {
                                                    // markers before the next verse
                                                    verseEndIdx = strContentsNoCRLF.indexOf(markerCache, verseStartIdx); // up to, but not including the next verse's markers
                                                    markerCache = ""; // clear out the cached value
                                                } else {
                                                    // no markers -- could be the last verse in the chapter
                                                    if (bVIDFound === true) {
                                                        // last verse in chapter
                                                        console.log("merge verse - end of chapter");
                                                        if (contents.indexOf("\\c ", verseStartIdx) > 0) {
                                                            verseEndIdx = contents.indexOf("\\c", verseStartIdx);
                                                        }
                                                    } else if (strExistingVerse !== "") {
                                                        // we have existing data for this verse, but no markers (shouldn't happen)
                                                        console.log("merge verse - found a verse missing markers");
                                                        verseEndIdx = contents.indexOf("\\v ", contents.indexOf(verseNum) + 2); // sanity check (shouldn't happen)                                                            
                                                    }
                                                }
                                            } else {
                                                verseEndIdx = contents.length - 1; // last verse
                                            }
                                            // 
                                            strImportedVerse = contents.substring(verseStartIdx, verseEndIdx);
                                            strImportedVerse = strImportedVerse.replace(CRLF_RE, " "); // remove CRLF chars
                                            strImportedVerse = strImportedVerse.replace(GspaceRE, " "); // single spaces only
                                            if (strImportedVerse.trim() !== strExistingVerse.replace(GspaceRE, " ").trim()) {
                                                console.log("merge verses differ: " + verseID);
                                                // verses differ -- 
                                                // Move [i] back to the beginning of the verse, and delete what we have in the DB.
                                                if (phIdx !== 0) {
                                                    i = phIdx; // this was the first \\ marker slot
                                                    phIdx = 0; // reset the placeholder
                                                }
                                                var tmpStart = -1;
                                                var tmpLength = 0;
                                                // Now delete the existing sourcephrases from the DB (we'll import below)
                                                for (tmpIdx=0; tmpIdx<spsExisting.length; tmpIdx++) {
                                                    if (spsExisting[tmpIdx].get("vid") === verseID) {
                                                        // delete this guy
                                                        tmpID = spsExisting[tmpIdx].get("spid");
                                                        tmpObj = sourcePhrases.findWhere({spid: tmpID});
                                                        sourcePhrases.remove(tmpObj);
                                                        tmpObj.destroy();
                                                        if (tmpStart === -1) {
                                                            tmpStart = tmpIdx;
                                                        }
                                                        tmpLength++;
                                                    }
                                                }
                                                // also clean out spsExisting
                                                spsExisting.splice(tmpStart, tmpLength);
                                                // place the imported data where the existing verse used to be
                                                norder = (tmpnorder - 100);
                                                markers = ""; // clear out the markers so we rebuild it correctly
                                                continue; // jump to while loop
                                            } else {
                                                console.log("merge verses same: " + verseID);
                                                // Merging an existing chapter/verse, but the verse is the same --
                                                // move our import index to the next verse / chapter position
                                                while (i < arr.length) {
                                                    // stop at next verse or chapter
                                                    if ((arr[i] === "\\v") || (arr[i] === "\\c")) {
                                                        break;
                                                    }
                                                    // stop if we've reached the markers for the next verse
                                                    if ((arr[i].length > 0) && (markerCache.length > 0) && (markerCache.indexOf(arr[i]) !== -1)) {
                                                        break;
                                                    }
                                                    i++;
                                                }
                                                markers = ""; // clear out the markers for this verse
                                                phIdx = 0; // clear phIdx
                                                continue; // jump to while loop
                                            }
                                        } else {
                                            verseID = window.Application.generateUUID(); // not an existing verse -- create a new verse ID
                                            norder += 100;
                                        } 
                                    } else {
                                        verseID = window.Application.generateUUID(); // new verse in a new chapter -- create a new verse ID
                                        norder += 100;
                                    }
                                    // EDB 30 Aug 2021: add blank verses (middle of content)
                                    var vCount = (markers.match(/\\v /g) || []).length;
                                    var realCount = vCount;
                                    var vIdx = 0;
                                    var aRange = [];
                                    // Each \v marker can be followed by a _range_ of verses (e.g. "\v 1-3") or a single verse.
                                    // Figure out how much we should increment the verseCount by
                                    for (var idx=0; idx<vCount; idx++) {
                                        vIdx = markers.indexOf("\\v ", vIdx) + 3;
                                        if (markers.lastIndexOf(" ") < vIdx) {
                                            // no space after the chapter # (it's the ending of the string)
                                            verseNum = markers.substr(vIdx);
                                        } else {
                                            // space after the chapter #
                                            verseNum = markers.substr(vIdx, markers.indexOf(" ", vIdx) - vIdx);
                                        }
                                        if (verseNum.indexOf("-") > -1) { 
                                            // this is a range - count the # of verses
                                            aRange = verseNum.split("-");
                                            realCount += (parseInt(aRange[1],10) - parseInt(aRange[0],10));
                                        }                                
                                    }
                                    if (realCount !== vCount) {
                                        console.log("Found at least 1 range of verses (middle of content). vCount=" + vCount + ", computed realCount=" + realCount);
                                    }
                                    verseCount = verseCount + realCount;
                                    if (vCount > 1) {
                                        // special case -- blank verses
                                        console.log("Blank verses found: " + vCount);
                                        var tmpMrks, Idx1, Idx2;
                                        if (spsExisting.length === 0) {
                                            // new content -- give this verse some room, in case we come back and merge data in a subsequent import
                                            norder = norder + 200;
                                        }
                                        for (var vIdx = 0; vIdx < (vCount - 1); vIdx++) {
                                            // pull out the marker for this blank verse
                                            Idx1 = markers.indexOf("\\v ", 0); // _this_ verse
                                            Idx2 = markers.indexOf("\\v ", Idx1 + 1); // next verse
                                            tmpMrks = markers.substring(0, Idx2); // up to the next verse
                                            markers = markers.substring(Idx2); // remaining marker string
                                            // create a blank sourcephrase (no source or target) for each verse
                                            spID = window.Application.generateUUID();
                                            verseID = window.Application.generateUUID(); // new verse (blank)
                                            // if we're merging, check for this blank verse in the DB.
                                            if (spsExisting.length > 0) {
                                                for (tmpIdx=0; tmpIdx<spsExisting.length; tmpIdx++) {
                                                    if (spsExisting[tmpIdx].get("markers").indexOf(tmpMrks) > -1) {
                                                        // found the blank verse sourcephrase -- delete it
                                                        norder = spsExisting[tmpIdx].get("norder");
                                                        verseID = spsExisting[tmpIdx].get("vid");
                                                        tmpID = spsExisting[tmpIdx].get("spid");
                                                        tmpObj = sourcePhrases.findWhere({spid: tmpID});
                                                        sourcePhrases.remove(tmpObj);
                                                        tmpObj.destroy();
                                                        console.log("Merge blank verse: " + tmpMrks + " (" + spID + ")");
                                                        break; // exit the for loop
                                                    }
                                                }
                                            }
                                            // create a sourcephrase for this blank verse
                                            sp = new spModel.SourcePhrase({
                                                spid: spID,
                                                norder: norder,
                                                chapterid: chapterID,
                                                vid: verseID,
                                                markers: tmpMrks,
                                                orig: null,
                                                prepuncts: prepuncts,
                                                midpuncts: midpuncts,
                                                follpuncts: follpuncts,
                                                source: "",
                                                target: ""
                                            });
                                            prepuncts = "";
                                            follpuncts = "";
                                            punctIdx = 0;
                                            norder = norder + 200; // en/KJV longest is 90 words/verse (Esther 8:9)
                                            sps.push(sp);
                                            phIdx = 0; // reset
                                            // if necessary, send the next batch of SourcePhrase INSERT transactions
                                            if ((sps.length % MAX_BATCH) === 0) {
                                                batchesSent++;
                                                updateStatus(i18n.t("view.dscStatusSaving", {number: batchesSent, details: i18n.t("view.detailChapterVerse", {chap: chapterName, verse: verseCount})}), 0);
                                                deferreds.push(sourcePhrases.addBatch(sps.slice(sps.length - MAX_BATCH)));
                                                deferreds[deferreds.length - 1].done(function() {
                                                    updateStatus(i18n.t("view.dscStatusSavingProgress", {number: deferreds.length, total: batchesSent}), Math.floor(deferreds.length / batchesSent * 100));
                                                });            
                                            }
                                        }
                                    }
                                }
                                s = arr[i];
                                // look for leading and trailing punctuation
                                // leading...
                                if (puncts.indexOf(arr[i].charAt(0)) > -1) {
                                    // leading punct 
                                    punctIdx = 0;
                                    while (puncts.indexOf(arr[i].charAt(punctIdx)) > -1 && punctIdx < arr[i].length) {
                                        prepuncts += arr[i].charAt(punctIdx);
                                        punctIdx++;
                                    }
                                }
                                if (punctIdx === s.length) {
                                    // it'a ALL punctuation -- jump to the next token
                                    i++;
                                } else {
                                    // not all punctuation -- check following punctuation, then create a sourcephrase
                                    if (puncts.indexOf(s.charAt(s.length - 1)) > -1) {
                                        // trailing punct 
                                        punctIdx = s.length - 1;
                                        while (puncts.indexOf(s.charAt(punctIdx)) > -1 && punctIdx > 0) {
                                            follpuncts = s.charAt(punctIdx) + follpuncts;
                                            punctIdx--;
                                        }
                                    }
                                    // Now create a new sourcephrase
                                    spID = window.Application.generateUUID();
                                    sp = new spModel.SourcePhrase({
                                        spid: spID,
                                        norder: norder,
                                        chapterid: chapterID,
                                        vid: verseID,
                                        markers: markers,
                                        orig: null,
                                        prepuncts: prepuncts,
                                        midpuncts: midpuncts,
                                        follpuncts: follpuncts,
                                        source: s,
                                        target: ""
                                    });
                                    markers = "";
                                    prepuncts = "";
                                    follpuncts = "";
                                    punctIdx = 0;
                                    index++;
                                    norder++;
                                    sps.push(sp);
                                    phIdx = 0; // reset
                                    // if necessary, send the next batch of SourcePhrase INSERT transactions
                                    if ((sps.length % MAX_BATCH) === 0) {
                                        batchesSent++;
                                        updateStatus(i18n.t("view.dscStatusSaving", {number: batchesSent, details: i18n.t("view.detailChapterVerse", {chap: chapterName, verse: verseCount})}), 0);
                                        deferreds.push(sourcePhrases.addBatch(sps.slice(sps.length - MAX_BATCH)));
                                        deferreds[deferreds.length - 1].done(function() {
                                            updateStatus(i18n.t("view.dscStatusSavingProgress", {number: deferreds.length, total: batchesSent}), Math.floor(deferreds.length / batchesSent * 100));
                                        });    
                                    }
                                    i++;
                                }
                            }
                        }
                        // done with the content array. Did we end on empty verses?
                        if (markers && markers.indexOf("\\v ") !== -1) {
                            var vCount = (markers.match(/\\v /g) || []).length;
                            var realCount = vCount;
                            var vIdx = 0;
                            var aRange = [];
                            // Each \v marker can be followed by a _range_ of verses (e.g. "\v 1-3") or a single verse.
                            // Figure out how much we should increment the verseCount by
                            for (var idx=0; idx<vCount; idx++) {
                                vIdx = markers.indexOf("\\v ", vIdx) + 3;
                                if (markers.lastIndexOf(" ") < vIdx) {
                                    // no space after the chapter # (it's the ending of the string)
                                    verseNum = markers.substr(vIdx);
                                } else {
                                    // space after the chapter #
                                    verseNum = markers.substr(vIdx, markers.indexOf(" ", vIdx) - vIdx);
                                }
                                if (verseNum.indexOf("-") > -1) { 
                                    // this is a range - count the # of verses
                                    aRange = verseNum.split("-");
                                    realCount += (parseInt(aRange[1],10) - parseInt(aRange[0],10));
                                }                                
                            }
                            if (realCount !== vCount) {
                                console.log("Found at least 1 range of verses (blank verses at end). vCount=" + vCount + ", computed realCount=" + realCount);
                            }
                            verseCount = verseCount + realCount;
                            if (vCount >= 1) {
                                // special case -- blank verses
                                console.log("Empty verse(s) at end: " + vCount);
                                var tmpMrks, Idx1, Idx2;
                                for (var vIdx = 0; vIdx < vCount; vIdx++) {
                                    // pull out the marker for this blank verse
                                    Idx1 = markers.indexOf("\\v ", 0); // _this_ verse
                                    Idx2 = markers.indexOf("\\v ", Idx1 + 1); // next verse
                                    tmpMrks = markers.substring(0, Idx2); // up to the next verse
                                    markers = markers.substring(Idx2); // remaining marker string
                                    if (tmpMrks.length === 0) {
                                        tmpMrks = markers; // last verse
                                    }
                                    // create a blank sourcephrase (no source or target) for each verse
                                    spID = window.Application.generateUUID();
                                    verseID = window.Application.generateUUID(); // new verse (blank)
                                    // if we're merging, check for this blank verse in the DB.
                                    if (spsExisting.length > 0) {
                                        for (tmpIdx=0; tmpIdx<spsExisting.length; tmpIdx++) {
                                            if (spsExisting[tmpIdx].get("markers").indexOf(tmpMrks) > -1) {
                                                // found the blank verse sourcephrase -- delete it
                                                norder = spsExisting[tmpIdx].get("norder");
                                                verseID = spsExisting[tmpIdx].get("vid");
                                                tmpID = spsExisting[tmpIdx].get("spid");
                                                tmpObj = sourcePhrases.findWhere({spid: tmpID});
                                                sourcePhrases.remove(tmpObj);
                                                tmpObj.destroy();
                                                console.log("Merge blank verse: " + tmpMrks + " (" + spID + ")");
                                                break; // exit the for loop
                                            }
                                        }
                                    } else {
                                        // no source phrases -- just add space so we can go back in and fill in the verse in a subsequent merge
                                        norder = norder + 200; // en/KJV longest is 90 words/verse (Esther 8:9)
                                    }
                                    sp = new spModel.SourcePhrase({
                                        spid: spID,
                                        norder: norder,
                                        chapterid: chapterID,
                                        vid: verseID,
                                        markers: tmpMrks,
                                        orig: null,
                                        prepuncts: prepuncts,
                                        midpuncts: midpuncts,
                                        follpuncts: follpuncts,
                                        source: "",
                                        target: ""
                                    });
                                    prepuncts = "";
                                    follpuncts = "";
                                    punctIdx = 0;
                                    sps.push(sp);
                                    phIdx = 0; // reset
                                    // if necessary, send the next batch of SourcePhrase INSERT transactions
                                    if ((sps.length % MAX_BATCH) === 0) {
                                        batchesSent++;
                                        updateStatus(i18n.t("view.dscStatusSaving", {number: batchesSent, details: i18n.t("view.detailChapterVerse", {chap: chapterName, verse: verseCount})}), 0);
                                        deferreds.push(sourcePhrases.addBatch(sps.slice(sps.length - MAX_BATCH)));
                                        deferreds[deferreds.length - 1].done(function() {
                                            updateStatus(i18n.t("view.dscStatusSavingProgress", {number: deferreds.length, total: batchesSent}), Math.floor(deferreds.length / batchesSent * 100));
                                        });    
                                    }
                                }
                            }
                        }
                        // Special case: a single chapter import into a new project
                        // (verseCount ends up > 0, and the lastAdaptedXXX aren't set yet)
                        if (verseCount > 0) {
                            // set the current bookmark if not already set
                            if (window.Application.currentBookmark === null) {
                                var bookmarkid = window.Application.generateUUID();
                                var newBookmark = new userModels.Bookmark({
                                    bookmarkid: bookmarkid,
                                    projectid: project.get('projectid'),
                                    name: chapterName,
                                    bookid: bookID,
                                    chapterid: chapterID // note: no spID set (will start at beginning)
                                });
                                // save and add to the collection
                                newBookmark.save();
                                window.Application.bookmarkList.add(newBookmark);
                                window.Application.currentBookmark = newBookmark;
                            } else if (window.Application.currentBookmark.get('bookid').length === 0) {
                                // project is set, but the book / chapter values are not set -- set them now
                                window.Application.currentBookmark.set("name", chapterName, {silent: true});
                                window.Application.currentBookmark.set("bookid", bookID, {silent: true});
                                window.Application.currentBookmark.set("chapterid", chapterID, {silent: true});
                                window.Application.currentBookmark.update();
                            }                       
                        }
                        // update the verse count for this chapter before closing it out
                        if (chapter.get('versecount') < verseCount) {
                            // only update if we're increasing the verse count
                            chapter.set('versecount', verseCount, {silent: true});
                        }
                        // now save all the chapters
                        for (i=0; i < numChaps; i++) {
                            chapterID = book.get("chapters")[i]; // get next chapterID of the book we're importing
                            chapter = chapters.where({chapterid: chapterID})[0]; // chapter object from chapters list
                            chapter.save(); // save it (could be INSERT or UPDATE operation)
                        }

                        // add any remaining sourcephrases
                        if ((sps.length % MAX_BATCH) > 0) {
                            batchesSent++;
                            updateStatus(i18n.t("view.dscStatusSaving", {number: batchesSent, details: i18n.t("view.detailChapterVerse", {chap: chapterName, verse: verseCount})}), 0);
                            deferreds.push(sourcePhrases.addBatch(sps.slice(sps.length - (sps.length % MAX_BATCH))));
                            deferreds[deferreds.length - 1].done(function() {
                                updateStatus(i18n.t("view.dscStatusSavingProgress", {number: deferreds.length, total: batchesSent}), Math.floor(deferreds.length / batchesSent * 100));
                            });
                        }

                        // track all those deferred calls to addBatch -- when they all complete, report the results to the user
                        intervalID = window.setInterval(function(deferreds) {
                            var result = checkState(deferreds);
                            if (result === "pending") {
                                // pending -- do nothing
                            } else if (result === "resolved") {
                                // resolved
                                clearInterval(intervalID);
                                intervalID = 0;
                                importSuccess();
                            } else {
                                // rejected
                                clearInterval(intervalID);
                                intervalID = 0;
                                importFail(result);
                            }
                        }, 1000);
                        return true; // success
                    }, function (msg) {
                        console.log(msg);
                        // User pressed Cancel on import (duplicate doc) - return to the main screen
                        if (window.history.length > 1) {
                            // there actually is a history -- go back
                            window.history.back();
                        } else {
                            // no history (import link from outside app) -- just go home
                            window.location.replace("");
                        }
                        return true; // success
                    }); // (possible pause for user confirmation dialog)
                    // END readUSFMDoc()
                };

                ///
                // END FILE TYPE READERS
                ///

                // did the FileReader.ReadAsText() call fail?
                if (this.error) {
                    importFail(this.error);
                    return false;
                }

                // convert contents to string
                var contents = new TextDecoder('utf-8').decode((this.result));

                // parse doc contents as appropriate
                if ((fileName.toLowerCase().indexOf(".usfm") > 0) || (fileName.toLowerCase().indexOf(".sfm") > 0)) {
                    // sfm/usfm doc -- does it contain \lx keywords for our KB?
                    index = contents.indexOf("\\lx ");
                    if (index >= 0) {
                        // looks like it has at least one \lx -- try reading as a sfm lex document
                        result = readSFMLexDoc(contents);
                    } else {
                        // no \lx -- try parsing as a plain old USFM doc
                        result = readUSFMDoc(contents);
                    }
                } else if (fileName.toLowerCase().indexOf(".usx") > 0) {
                    result = readUSXDoc(contents);
                } else if (fileName.toLowerCase().indexOf(".lift") > 0) {
                    result = readLIFTDoc(contents);
                } else if (fileName.toLowerCase().indexOf(".tmx") > 0) {
                    result = readTMXDoc(contents);
                } else if (fileName.toLowerCase().indexOf(".xml") > 0) {
                    if (fileName.toLowerCase().indexOf("adaptations.xml") > 0) {
                        // possibly a KB
                        result = readKBXMLDoc(contents);
                    } else if (fileName.toLowerCase().indexOf("glossing.xml") > 0) {
                        result = readGlossXMLDoc(contents);
                    } else {
                        // possibly an Adapt It XML document
                        result = readXMLDoc(contents);
                    }
                } else if (fileName.toLowerCase().indexOf(".txt") > 0) {
                    // .txt -- check to see if it's really USFM under the hood
                    // find the ID of this book
                    index = contents.indexOf("\\id");
                    if (index >= 0) {
                        // _probably_ USFM under the hood -- at least try to read it as USFM
                        result = readUSFMDoc(contents);
                    } else {
                        // not a USFM doc per se; does it have keyword lex info for our KB?
                        index = contents.indexOf("\\lx ");
                        if (index >= 0) {
                            // looks like it has at least one \lx -- try reading as a sfm lex document
                            result = readSFMLexDoc(contents);
                        } else {
                            // try reading it as a text document
                            result = readTextDoc(contents);
                        }
                    }
                } else if (fileName.toLowerCase().indexOf(".aic") > 0) {
                    // create a new project object and populate it from the file contents
                    isProjectFile = true;
                    var newProj = new projModel.Project();
                    newProj.fromString(contents).done(function() {
                        // success -- save the object and add to the collection
                        newProj.save();
                        window.Application.ProjectList.add(newProj);
                        fileName = newProj.get('name');
                        importSuccess();
                    }).fail(function (err) {
                        importFail(err);
                    });
                    return; // projects 
                } else {
                    if (isClipboard === true) {
                        // this came from the clipboard -- we'll need to do some tests to try to identify the content type.
                        // NOTE: this needs the whole file on the clipboard to be treated as formatted content -- copying
                        // a verse or two will just case it to be treated as regular text, because we're relying on the intro
                        // content to determine the format.
                        var newFileName = "";
                        if (contents.indexOf("tmx version=") >= 0) {
                            result = readTMXDoc(contents);
                        } else if (contents.indexOf("glossingKB=\"1") >= 0) {
                            // _probably_ a glossing KB XML document
                            result = readGlossXMLDoc(contents);
                        } else if (contents.indexOf("KB kbVersion") >= 0) {
                            // _probably_ a Knowledge base document under the hood
                            result = readKBXMLDoc(contents);
                        } else if (contents.indexOf("AdaptItDoc") >= 0) {
                            // _probably_ an Adapt It XML document under the hood
                            index = contents.indexOf("S s="); // move to content
                            index = contents.indexOf("\\h ", index); // first \\h in content
                            if (index > -1) {
                                // there is a \h marker -- look backwards for the nearest "a" attribute (this is the adapted name)
                                var idxs = contents.lastIndexOf("s=", index) + 3;
                                // Sanity check -- this \\h element might not have an adaptation
                                // (if it doesn't, there won't be a a="" after the s="" attribute)
                                if (contents.lastIndexOf("a=", index) > idxs) {
                                    // Okay, this looks legit. Pull out the adapted book name from the file.
                                    index = contents.lastIndexOf("a=", index) + 3;
                                    newFileName = contents.substr(index, contents.indexOf("\"", index) - index);
                                    if (newFileName.length > 0) {
                                        fileName = newFileName;
                                    }
                                }
                            }
                            result = readXMLDoc(contents);
                        } else if (contents.indexOf("usx version") >= 0) {
                            // _probably_ USX document under the hood
                            index = contents.indexOf("style=\"h\"");
                            if (index > -1) {
                                // try to get a readable name from the usx <para style="h"> node
                                newFileName = contents.substr(index + 10, (contents.indexOf("\<", index) - (index + 10))).trim();
                                if (newFileName.length > 0) {
                                    fileName = newFileName;
                                }
                            }
                            result = readUSXDoc(contents);
                        } else if (contents.indexOf("PunctuationTwoCharacterPairsSourceSet") >= 0) {
                            // _probably adapt it configuration (aic) file contents
                            // create a new project object and populate it from the clipboard contents
                            isProjectFile = true;
                            var newProj = new projModel.Project();
                            newProj.fromString(contents).done(function() {
                                // success -- save the object and add to the collection
                                newProj.save();
                                window.Application.ProjectList.add(newProj);
                                fileName = newProj.get('name');
                                importSuccess();
                            }).fail(function (err) {
                                importFail(err);
                            });
                        } else if (contents.indexOf("\\id") >= 0) {
                            // _probably_ USFM under the hood
                            index = contents.indexOf("\\h ");
                            if (index > -1) {
                                // try to get a readable name from the usfm \\h node
                                newFileName = contents.substr(index + 3, (contents.indexOf("\n", index) - (index + 3))).trim();
                                if (newFileName.length > 0) {
                                    fileName = newFileName;
                                }
                            }
                            result = readUSFMDoc(contents);
                        } else if (contents.indexOf("<lift ") >= 0) {
                            // maybe a LIFT document
                            result = readLIFTDoc(contents);   
                        } else if (contents.indexOf("\\lx") >= 0) {
                            // _probably_ \lx data for the KB
                            result = readSFMLexDoc(contents);
                        } else {
                            // unknown -- try reading it as a text document
                            result = readTextDoc(contents);
                        }
                    } else {
                        // some other extension (or no extension) -- try reading it as a text document
                        result = readTextDoc(contents);
                    }
                }
                if (result === false) {
                    importFail(new Error(errMsg));
                }
            };
            reader.readAsArrayBuffer(file);
            //reader.readAsText(file);
        }, // importFile
        
        
        // Helper method to export the given bookid to the specified file format.
        // Called from ExportDocumentView::onOK once the book, format and filename have been chosen.
        exportDocument = function (bookid, format, filename, content) {
            var status = "";
            var writer = null;
            var sType = "text/plain"; // default MIME type (text)
            var bResult = true;
            // Callback for when the file is imported / saved successfully
            var exportSuccess = function () {
                console.log("exportSuccess()");
                bOperationDone = true;
                // update status
                if (isClipboard === true) {
                    // just tell the user it succeeded
                    status = "<p>" + i18n.t("view.dscStatusExportSuccess") + "</p>";
                } else {
                    // tell the user it succeeded, and also the file path / name
                    status = "<p>" + i18n.t("view.dscFile", {file: (filename)}) + "</p><p>" +
                        i18n.t("view.dscStatusExportSuccess") + "</p>";
                }
                isClipboard = false; // reset the clipboard flag
                $("#status").html(status);
                // display the OK button
                $("#loading").hide();
                $("#waiting").hide();
                $("#btnCancel").hide();
                $("#btnOK").removeClass("hide");
                $("#btnOK").removeAttr("disabled");
            };
            // Callback for when the file failed to import
            var exportFail = function (e) {
                console.log("exportFail(): " + e.message);
                bOperationDone = true;
                isClipboard = false; // reset the clipboard flag
                // update status
                $("#status").html(i18n.t("view.dscExportFailed", {document: filename, reason: e.message}));
                $("#loading").hide();
                $("#waiting").hide();
                // display the OK button
                $("#btnOK").removeClass("hide");
                $("#btnOK").removeAttr("disabled");
            };
            
            ///
            // FILE TYPE WRITERS
            // These populate the static strContents variable with the document contents in the specified file format --
            // the caller (exportDocument) then copies the result to the clipboard or saves it to a file (cleaning out the static before/after).
            //
            // There are 2 loops for each file type -- a chapter and source phrase loop.
            // The AI XML export will dump out the entire book; the others use the following logic:
            // - If the chapter has at least some adaptations in it, we'll export it
            // - If we encounter the lastSPID, we'll break out of the export loop of the chapter.
            // This logic works well if the user is adapting sequentially. If the user is jumping around in their adaptations,
            // some chapters might have extraneous punctuation from areas where they haven't adapted.
            //
            // Also note that the non-AI XML document exports can have empty content if no translations have been done --
            // we use a flag (bDirty) to track this condition and tell the user if there was nothing to export.
            // Each method returns true for success, false for failure
            ///

            // Plain Text document
            // We assume these are just text with no markup,
            // in a single chapter (this could change if needed)
            var buildText = function () {
                var chapters = window.Application.ChapterList.where({bookid: bookid});
                var spList = new spModel.SourcePhraseCollection();
                var markerList = new USFM.MarkerCollection();
                var i = 0;
                var idxFilters = 0;
                var value = null;
                var filterAry = window.Application.currentProject.get('FilterMarkers').split("\\");
                var lastSPID = window.Application.currentBookmark.get('spid');
                var chaptersLeft = chapters.length;
                var filtered = false;
                var needsEndMarker = "";
                var mkr = "";
                var bDirty = false;
                // get the chapters belonging to our book
                markerList.fetch({reset: true, data: {name: ""}});
                console.log("markerList count: " + markerList.length);
                //lastSPID = lastSPID.substring(lastSPID.lastIndexOf("-") + 1);
                console.log("filterAry: " + filterAry.toString());
                chapters.forEach(function (entry) {
                    // for each chapter with some adaptation done, get the sourcephrases
                    if (entry.get('lastadapted') !== 0) {
                        // add a placeholder string for this chapter, so that it ends up in order (the call to
                        // fetch() is async, and sometimes the chapters are returned out of order)
                        bDirty = true;
                        strContents += "**" + entry.get("chapterid") + "**";
                        spList.fetch({reset: true, data: {chapterid: entry.get("chapterid")}}).done(function () {
                            var chapterString = "";
                            console.log("spList: " + spList.length + " items, last id = " + lastSPID);
                            for (i = 0; i < spList.length; i++) {
                                value = spList.at(i);
                                // plain text -- we're not all that interested in formatting, but do add some
                                // line breaks for chapter, verse, paragraph marks
                                if ((value.get("markers").indexOf("\\c") > -1) || (value.get("markers").indexOf("\\v") > -1) ||
                                        (value.get("markers").indexOf("\\h") > -1) || (value.get("markers").indexOf("\\p") > -1)) {
                                    chapterString += "\n"; // newline
                                }
                                // check to see if this sourcephrase is filtered (only looking at the top level)
                                if (filtered === false) {
                                    for (idxFilters = 0; idxFilters < filterAry.length; idxFilters++) {
                                        // sanity check for blank filter strings
                                        if (filterAry[idxFilters].trim().length > 0) {
                                            if (value.get("markers").indexOf(filterAry[idxFilters]) >= 0) {
                                                // this is a filtered sourcephrase -- do not export it
                                                console.log("filtered: " + value.get("markers"));
                                                // if there is an end marker associated with this marker,
                                                // do not export any source phrases until we come across the end marker
                                                mkr = markerList.where({name: filterAry[idxFilters].trim()});
                                                if (mkr[0].get("endMarker")) {
                                                    needsEndMarker = mkr[0].get("endMarker");
                                                }
                                                filtered = true;
                                            }
                                        }
                                    }
                                }
                                if (value.get("markers").indexOf(needsEndMarker) >= 0) {
                                    // found our ending marker -- this sourcephrase is not filtered
                                    needsEndMarker = "";
                                    filtered = false;
                                }
                                if (filtered === false) {
                                    // only emit soursephrase pre/foll puncts if we have something translated in the target
                                    if (value.get("source").length > 0 && value.get("target").length > 0) {
                                        chapterString += value.get("target") + " ";
                                    }
                                }
                                if (value.get('spid') === lastSPID) {
                                    // done -- quit after this sourcePhrase
                                    console.log("Found last SPID: " + lastSPID);
                                    break;
                                }
                            }
                            // Now take the string from this chapter's sourcephrases that we've just built and
                            // insert them into the correct location in the file's strContents string
                            strContents = strContents.replace(("**" + entry.get("chapterid") + "**"), chapterString);
                            // decrement the chapter count, closing things out if needed
                            chaptersLeft--;
                            if (chaptersLeft === 0) {
                                console.log("finished within sp block");
                            }
                        });
                    } else {
                        // no sourcephrases to export -- just decrement the chapters, and close things out if needed
                        chaptersLeft--;
                        if (chaptersLeft === 0) {
                            console.log("finished in a blank block");
                            if (bDirty === false) {
                                // didn't export anything
                                exportFail(new Error(i18n.t('view.dscErrNothingToExport')));
                                return false;
                            } 
                        }
                    }
                    if (bDirty === false) {
                        // didn't export anything
                        exportFail(new Error(i18n.t('view.dscErrNothingToExport')));
                        return false;                  
                    }
                });
                if (strContents === "") {
                    // didn't export anything
                    exportFail(new Error(i18n.t('view.dscErrNothingToExport')));
                    return false;
                } else {
                    // success
                    return true;
                }
            };

            // USFM document export (target text)
            var buildUSFM = function () {
                var chapters = window.Application.ChapterList.where({bookid: bookid});
                var spList = new spModel.SourcePhraseCollection();
                var markerList = new USFM.MarkerCollection();
                var markers = "";
                var i = 0;
                var idxFilters = 0;
                var value = null;
                var chaptersLeft = chapters.length;
                var filtered = false;
                var needsEndMarker = "";
                var mkr = "";
                var bDirty = false;
                var filterAry = window.Application.currentProject.get('FilterMarkers').split("\\");
                var lastSPID = window.Application.currentBookmark.get('spid');
                console.log("buildUSFM: entry");
                markerList.fetch({reset: true, data: {name: ""}});
                console.log("markerList count: " + markerList.length);
                //lastSPID = lastSPID.substring(lastSPID.lastIndexOf("-") + 1);
                chapters.forEach(function (entry) {
                    // for each chapter with some adaptation done, get the sourcephrases
                    if (entry.get('lastadapted') !== 0) {
                        // add a placeholder string for this chapter, so that it ends up in order (the call to
                        // fetch() is async, and sometimes the chapters are returned out of order)
                        bDirty = true;
                        strContents += "**" + entry.get("chapterid") + "**";
                        spList.fetch({reset: true, data: {chapterid: entry.get("chapterid")}}).done(function () {
                            var chapterString = "";
                            console.log("spList: " + spList.length + " items, last id = " + lastSPID);
                            for (i = 0; i < spList.length; i++) {
                                value = spList.at(i);
                                markers = value.get("markers");
                                if (markers !== "") {
                                    // filter processing
                                    markers += " "; // add trailing space to handle last marker
                                    // check to see if this sourcephrase is filtered (only looking at the top level)
                                    if (filtered === false) {
                                        for (idxFilters = 0; idxFilters < filterAry.length; idxFilters++) {
                                            // sanity check for blank filter strings
                                            if (filterAry[idxFilters].trim().length > 0) {
                                                if (markers.indexOf(filterAry[idxFilters]) >= 0) {
                                                    // this is a filtered sourcephrase -- do not export it
                                                    console.log("filtered: " + markers);
                                                    // however, if there are some markers before we hit our filtered one, 
                                                    // make sure they get exported now
                                                    markers = markers.substr(0, markers.indexOf(filterAry[idxFilters]) - 1);
                                                    if (markers.length > 0) {
                                                        if ((markers.indexOf("\\v") > -1) || (markers.indexOf("\\c") > -1) ||
                                                                (markers.indexOf("\\p") > -1) || (markers.indexOf("\\id ") > -1) ||
                                                                (markers.indexOf("\\h") > -1) || (markers.indexOf("\\toc") > -1) || (markers.indexOf("\\mt") > -1)) {
                                                            // pretty-printing -- add a newline so the output looks better
                                                            chapterString += "\n"; // newline
                                                        }
                                                        // now add the markers and a space
                                                        chapterString += markers + " ";
                                                    }
                                                    chapterString += (markers.substr(0, markers.indexOf(filterAry[idxFilters]))) + " ";
                                                    // if there is an end marker associated with this marker,
                                                    // do not export any source phrases until we come across the end marker
                                                    mkr = markerList.where({name: filterAry[idxFilters].trim()});
                                                    if (mkr[0].get("endMarker")) {
                                                        needsEndMarker = mkr[0].get("endMarker");
                                                    }
                                                    filtered = true;
                                                }
                                            }
                                        }
                                    }
                                    if ((needsEndMarker.length > 0) && (markers.indexOf(needsEndMarker) >= 0)) {
                                        // found our ending marker -- this sourcephrase is not filtered
                                        // first, remove the marker from the markers string so it doesn't print out
                                        markers = markers.replace(("\\" + needsEndMarker), '');
                                        // now clear our flags so the sourcephrase exports
                                        needsEndMarker = "";
                                        filtered = false;
                                    }
                                }
                                if (filtered === false) {
                                    // add markers, and if needed, pretty-print the text on a newline
                                    if (markers.trim().length > 0) {
                                        if ((markers.indexOf("\\v") > -1) || (markers.indexOf("\\c") > -1) || (markers.indexOf("\\p") > -1) || (markers.indexOf("\\id") > -1) || (markers.indexOf("\\h") > -1) || (markers.indexOf("\\toc") > -1) || (markers.indexOf("\\mt") > -1)) {
                                            // pretty-printing -- add a newline so the output looks better
                                            chapterString += "\n"; // newline
                                        }
                                        // now add the markers and a space
                                        chapterString += markers + " ";
                                    }
                                    // only emit soursephrase pre/foll puncts if we have something translated in the target
                                    if (value.get("source").length > 0 && value.get("target").length > 0) {
                                        chapterString += value.get("target") + " ";
                                    }
                                }
                                if (filtered === true && needsEndMarker === "") {
                                    // one-off filter -- turn off filtering
                                    console.log("one-off filter, disabling after: " + value.get("source"));
                                    filtered = false;
                                }
                                if (value.get('spid') === lastSPID) {
                                    // done -- quit after this sourcePhrase
                                    console.log("Found last SPID: " + lastSPID);
                                    break;
                                }
                            }
                            // Now take the string from this chapter's sourcephrases that we've just built and
                            // insert them into the correct location in the file's strContents string
                            strContents = strContents.replace(("**" + entry.get("chapterid") + "**"), chapterString);
                            // decrement the chapter count, closing things out if needed
                            chaptersLeft--;
                            if (chaptersLeft === 0) {
                                console.log("finished within sp block");
                            }
                        });
                    } else {
                        // no sourcephrases to export -- just decrement the chapters, and close things out if needed
                        chaptersLeft--;
                        if (chaptersLeft === 0) {
                            console.log("finished in a blank block");
                            if (bDirty === false) {
                                // didn't export anything
                                exportFail(new Error(i18n.t('view.dscErrNothingToExport')));
                                return false;
                            } 
                        }
                    }
                    if (bDirty === false) {
                        // didn't export anything
                        exportFail(new Error(i18n.t('view.dscErrNothingToExport')));      
                        return false;                  
                    }
                });
                if (strContents === "") {
                    // didn't export anything
                    exportFail(new Error(i18n.t('view.dscErrNothingToExport')));
                    return false;
                } else {
                    // success
                    return true;
                }
            };

            // USFM, but gloss export only
            var buildUSFMGloss = function () {
                var chapters = window.Application.ChapterList.where({bookid: bookid});
                var spList = new spModel.SourcePhraseCollection();
                var markerList = new USFM.MarkerCollection();
                var markers = "";
                var i = 0;
                var idxFilters = 0;
                var value = null;
                var chaptersLeft = chapters.length;
                var filtered = false;
                var needsEndMarker = "";
                var mkr = "";
                var filterAry = window.Application.currentProject.get('FilterMarkers').split("\\");
                var lastSPID = window.Application.currentBookmark.get('spid');
                var bDirty = false;
                console.log("buildUSFMGloss: entry");
                markerList.fetch({reset: true, data: {name: ""}});
                console.log("markerList count: " + markerList.length);
                //lastSPID = lastSPID.substring(lastSPID.lastIndexOf("-") + 1);
                chapters.forEach(function (entry) {
                    // for each chapter with some adaptation done, get the sourcephrases
                    if (entry.get('lastadapted') !== 0) {
                        // add a placeholder string for this chapter, so that it ends up in order (the call to
                        // fetch() is async, and sometimes the chapters are returned out of order)
                        bDirty = true; // we're exporting something
                        strContents += "**" + entry.get("chapterid") + "**";
                        spList.fetch({reset: true, data: {chapterid: entry.get("chapterid")}}).done(function () {
                            var chapterString = "";
                            console.log("spList: " + spList.length + " items, last id = " + lastSPID);
                            for (i = 0; i < spList.length; i++) {
                                value = spList.at(i);
                                markers = value.get("markers");
                                // check to see if this sourcephrase is filtered (only looking at the top level)
                                if (filtered === false) {
                                    for (idxFilters = 0; idxFilters < filterAry.length; idxFilters++) {
                                        // sanity check for blank filter strings
                                        if (filterAry[idxFilters].trim().length > 0) {
                                            if (markers.indexOf(filterAry[idxFilters]) >= 0) {
                                                // this is a filtered sourcephrase -- do not export it
                                                console.log("filtered: " + markers);
                                                // however, if there are some markers before we hit our filtered one, 
                                                // make sure they get exported now
                                                markers = markers.substr(0, markers.indexOf(filterAry[idxFilters]) - 1);
                                                if (markers.length > 0) {
                                                    if ((markers.indexOf("\\v") > -1) || (markers.indexOf("\\c") > -1) ||
                                                            (markers.indexOf("\\p") > -1) || (markers.indexOf("\\id") > -1) ||
                                                            (markers.indexOf("\\h") > -1) || (markers.indexOf("\\toc") > -1) || (markers.indexOf("\\mt") > -1)) {
                                                        // pretty-printing -- add a newline so the output looks better
                                                        chapterString += "\n"; // newline
                                                    }
                                                    // now add the markers and a space
                                                    chapterString += markers + " ";
                                                }
                                                chapterString += (markers.substr(0, markers.indexOf(filterAry[idxFilters]))) + " ";
                                                // if there is an end marker associated with this marker,
                                                // do not export any source phrases until we come across the end marker
                                                mkr = markerList.where({name: filterAry[idxFilters].trim()});
                                                if (mkr[0].get("endMarker")) {
                                                    needsEndMarker = mkr[0].get("endMarker");
                                                }
                                                filtered = true;
                                            }
                                        }
                                    }
                                }
                                if ((needsEndMarker.length > 0) && (markers.indexOf(needsEndMarker) >= 0)) {
                                    // found our ending marker -- this sourcephrase is not filtered
                                    // first, remove the marker from the markers string so it doesn't print out
                                    markers = markers.replace(("\\" + needsEndMarker), '');
                                    // now clear our flags so the sourcephrase exports
                                    needsEndMarker = "";
                                    filtered = false;
                                }
                                if (filtered === false) {
                                    // add markers, and if needed, pretty-print the text on a newline
                                    if (markers.trim().length > 0) {
                                        if ((markers.indexOf("\\v") > -1) || (markers.indexOf("\\c") > -1) || (markers.indexOf("\\p") > -1) || (markers.indexOf("\\id") > -1) || (markers.indexOf("\\h") > -1) || (markers.indexOf("\\toc") > -1) || (markers.indexOf("\\mt") > -1)) {
                                            // pretty-printing -- add a newline so the output looks better
                                            chapterString += "\n"; // newline
                                        }
                                        // now add the markers and a space
                                        chapterString += markers + " ";
                                    }
                                    // only emit soursephrase pre/foll puncts if we have something translated in the gloss
                                    if (value.get("source").length > 0 && value.get("gloss").length > 0) {
                                        chapterString += value.get("gloss") + " ";
                                    }
                                }
                                if (value.get('spid') === lastSPID) {
                                    // done -- quit after this sourcePhrase
                                    console.log("Found last SPID: " + lastSPID);
                                    break;
                                }
                            }
                            // Now take the string from this chapter's sourcephrases that we've just built and
                            // insert them into the correct location in the file's strContents string
                            strContents = strContents.replace(("**" + entry.get("chapterid") + "**"), chapterString);
                            // decrement the chapter count, closing things out if needed
                            chaptersLeft--;
                            if (chaptersLeft === 0) {
                                console.log("finished within sp block");
                            }
                        });
                    } else {
                        // no sourcephrases to export -- just decrement the chapters, and close things out if needed
                        chaptersLeft--;
                        if (chaptersLeft === 0) {
                            console.log("finished in a blank block");
                            if (bDirty === false) {
                                // didn't export anything
                                exportFail(new Error(i18n.t('view.dscErrNothingToExport')));
                                return false;
                            } 
                        }
                    }
                    if (bDirty === false) {
                        // didn't export anything
                        exportFail(new Error(i18n.t('view.dscErrNothingToExport')));
                        return false;                      
                    }
                });
                if (strContents === "") {
                    // didn't export anything
                    exportFail(new Error(i18n.t('view.dscErrNothingToExport')));
                    return false;
                } else {
                    // success
                    return true;
                }
            };

            // USFM, but free translation only
            var buildUSFMFT = function () {
                var chapters = window.Application.ChapterList.where({bookid: bookid});
                var spList = new spModel.SourcePhraseCollection();
                var markerList = new USFM.MarkerCollection();
                var markers = "";
                var i = 0;
                var idxFilters = 0;
                var value = null;
                var chaptersLeft = chapters.length;
                var filtered = false;
                var needsEndMarker = "";
                var mkr = "";
                var filterAry = window.Application.currentProject.get('FilterMarkers').split("\\");
                var lastSPID = window.Application.currentBookmark.get('spid');
                var bDirty = false;
                console.log("buildUSFMFT: entry");
                markerList.fetch({reset: true, data: {name: ""}});
                console.log("markerList count: " + markerList.length);
                //lastSPID = lastSPID.substring(lastSPID.lastIndexOf("-") + 1);
                chapters.forEach(function (entry) {
                    // for each chapter with some adaptation done, get the sourcephrases
                    if (entry.get('lastadapted') !== 0) {
                        // add a placeholder string for this chapter, so that it ends up in order (the call to
                        // fetch() is async, and sometimes the chapters are returned out of order)
                        bDirty = true; // we're actually writing something
                        strContents += "**" + entry.get("chapterid") + "**";
                        spList.fetch({reset: true, data: {chapterid: entry.get("chapterid")}}).done(function () {
                            var chapterString = "";
                            console.log("spList: " + spList.length + " items, last id = " + lastSPID);
                            for (i = 0; i < spList.length; i++) {
                                value = spList.at(i);
                                markers = value.get("markers");
                                // check to see if this sourcephrase is filtered (only looking at the top level)
                                if (filtered === false) {
                                    for (idxFilters = 0; idxFilters < filterAry.length; idxFilters++) {
                                        // sanity check for blank filter strings
                                        if (filterAry[idxFilters].trim().length > 0) {
                                            if (markers.indexOf(filterAry[idxFilters]) >= 0) {
                                                // this is a filtered sourcephrase -- do not export it
                                                console.log("filtered: " + markers);
                                                // however, if there are some markers before we hit our filtered one, 
                                                // make sure they get exported now
                                                markers = markers.substr(0, markers.indexOf(filterAry[idxFilters]) - 1);
                                                if (markers.length > 0) {
                                                    if ((markers.indexOf("\\v") > -1) || (markers.indexOf("\\c") > -1) ||
                                                            (markers.indexOf("\\p") > -1) || (markers.indexOf("\\id") > -1) ||
                                                            (markers.indexOf("\\h") > -1) || (markers.indexOf("\\toc") > -1) || (markers.indexOf("\\mt") > -1)) {
                                                        // pretty-printing -- add a newline so the output looks better
                                                        chapterString += "\n"; // newline
                                                    }
                                                    // now add the markers and a space
                                                    chapterString += markers + " ";
                                                }
                                                chapterString += (markers.substr(0, markers.indexOf(filterAry[idxFilters]))) + " ";
                                                // if there is an end marker associated with this marker,
                                                // do not export any source phrases until we come across the end marker
                                                mkr = markerList.where({name: filterAry[idxFilters].trim()});
                                                if (mkr[0].get("endMarker")) {
                                                    needsEndMarker = mkr[0].get("endMarker");
                                                }
                                                filtered = true;
                                            }
                                        }
                                    }
                                }
                                if ((needsEndMarker.length > 0) && (markers.indexOf(needsEndMarker) >= 0)) {
                                    // found our ending marker -- this sourcephrase is not filtered
                                    // first, remove the marker from the markers string so it doesn't print out
                                    markers = markers.replace(("\\" + needsEndMarker), '');
                                    // now clear our flags so the sourcephrase exports
                                    needsEndMarker = "";
                                    filtered = false;
                                }
                                if (filtered === false) {
                                    // add markers, and if needed, pretty-print the text on a newline
                                    if (markers.trim().length > 0) {
                                        if ((markers.indexOf("\\v") > -1) || (markers.indexOf("\\c") > -1) || (markers.indexOf("\\p") > -1) || (markers.indexOf("\\id") > -1) || (markers.indexOf("\\h") > -1) || (markers.indexOf("\\toc") > -1) || (markers.indexOf("\\mt") > -1)) {
                                            // pretty-printing -- add a newline so the output looks better
                                            chapterString += "\n"; // newline
                                        }
                                        // now add the markers and a space
                                        chapterString += markers + " ";
                                    }
                                    // only emit soursephrase pre/foll puncts if we have something translated in the target
                                    if (value.get("source").length > 0 && value.get("freetrans").length > 0) {
                                        chapterString += value.get("freetrans") + " ";
                                    }
                                }
                                if (value.get('spid') === lastSPID) {
                                    // done -- quit after this sourcePhrase
                                    console.log("Found last SPID: " + lastSPID);
                                    break;
                                }
                            }
                            // Now take the string from this chapter's sourcephrases that we've just built and
                            // insert them into the correct location in the file's strContents string
                            strContents = strContents.replace(("**" + entry.get("chapterid") + "**"), chapterString);
                            // decrement the chapter count, closing things out if needed
                            chaptersLeft--;
                            if (chaptersLeft === 0) {
                                console.log("finished within sp block");
                            }
                        });
                    } else {
                        // no sourcephrases to export -- just decrement the chapters, and close things out if needed
                        chaptersLeft--;
                        if (chaptersLeft === 0) {
                            console.log("finished in a blank block");
                            if (bDirty === false) {
                                // didn't export anything
                                exportFail(new Error(i18n.t('view.dscErrNothingToExport')));
                                return false;
                            }
                        }
                    }
                    if (bDirty === false) {
                        // didn't export anything
                        exportFail(new Error(i18n.t('view.dscErrNothingToExport')));
                        return false;      
                    }
                });
                if (strContents === "") {
                    // didn't export anything
                    exportFail(new Error(i18n.t('view.dscErrNothingToExport')));
                    return false;
                } else {
                    // success
                    return true;
                }
            };

            // USX document
            var buildUSX = function () {
                var chapters = window.Application.ChapterList.where({bookid: bookid});
                var book = window.Application.BookList.where({bookid: bookid})[0];
                var bookID = book.get('scrid');
                var XML_PROLOG = "<?xml version=\"1.0\" encoding=\"utf-8\"?>";
                var spList = new spModel.SourcePhraseCollection();
                var markerList = new USFM.MarkerCollection();
                var filterAry = window.Application.currentProject.get('FilterMarkers').split("\\");
                var lastSPID = window.Application.currentBookmark.get('spid');
                var filtered = false;
                var exportMarkers = false;
                var isPeriphBlock = false;
                var isBookBlock = false;
                var isParaBlock = false;
                var tableBlockLevel = 0;
                var needsEndMarker = "";
                var markers = "";
                var i = 0;
                var spIdx = 0;
                var mkrIdx = 0;
                var strTemp = "";
                var idxFilters = 0;
                var pos = 0;
                var closeNode = ""; // holds ending string for <para> and <book> XML nodes
                var value = null;
                var mkr = "";
                var markerAry = [];
                var isEndMarker = false;
                var strMarker = "";
                var strOptions = "";
                var chaptersLeft = chapters.length;
                // starting material -- xml prolog and usx tag
                // using USX 3.0 (https://ubsicap.github.io/usx/v3.0.0/index.html)
                strContents = XML_PROLOG + "\n<usx version=\"3.0\">";
                // get the chapters belonging to our book
                markerList.fetch({reset: true, data: {name: ""}});
                console.log("markerList count: " + markerList.length);
                //lastSPID = lastSPID.substring(lastSPID.lastIndexOf("-") + 1);
                chapters.forEach(function (entry) {
                    // for each chapter with some adaptation done, get the sourcephrases
                    if (entry.get('lastadapted') !== 0) {
                        // add a placeholder string for this chapter, so that it ends up in order (the call to
                        // fetch() is async, and sometimes the chapters are returned out of order)
                        strContents += "**" + entry.get("chapterid") + "**";
                        spList.fetch({reset: true, data: {chapterid: entry.get("chapterid")}}).done(function () {
                            var chapterString = "";
                            console.log("spList: " + spList.length + " items, last id = " + lastSPID);
                            for (spIdx = 0; spIdx < spList.length; spIdx++) {
                                value = spList.at(spIdx);
                                markers = value.get("markers");
                                if (markers.length > 0 && isBookBlock === true) {
                                    // Close out the <book> element -- and add an IDE block -- 
                                    // before processing the next marker
                                    chapterString += "</book>\n<para style=\"ide\">UTF-8</para>";
                                    isBookBlock = false;
                                }
                                if (filtered === true && markers.length > 0 && needsEndMarker.length === 0) {
                                    // hit the next strip; this is an implicit end to the filtering (there's no end marker)
                                    filtered = false;
                                }
                                // check to see if this sourcephrase is filtered (only looking at the top level)
                                if (filtered === false) {
                                    for (idxFilters = 0; idxFilters < filterAry.length; idxFilters++) {
                                        // sanity check for blank filter strings
                                        if (filterAry[idxFilters].trim().length > 0) {
                                            mkrIdx = markers.indexOf(filterAry[idxFilters].trim());
                                            if ((mkrIdx >= 0) && (markers.charAt(mkrIdx - 1) === "\\")) {
                                                // one more test -- is the marker string _exactly_ the same
                                                // as our filter?
                                                if (markers.indexOf(" ", mkrIdx) !== -1) {
                                                    strTemp = markers.substring(mkrIdx, (markers.indexOf(" ", mkrIdx)));
                                                } else {
                                                    strTemp = markers.substring(mkrIdx);
                                                }
                                                if (strTemp.length === filterAry[idxFilters].trim().length) {
                                                    // this is a filtered sourcephrase -- do not export it
                                                    // if there is an end marker associated with this marker,
                                                    // do not export any source phrases until we come across the end marker
                                                    mkr = markerList.where({name: filterAry[idxFilters].trim()});
                                                    if (mkr[0].get("endMarker")) {
                                                        needsEndMarker = mkr[0].get("endMarker");
                                                    }
                                                    filtered = true;
                                                    //console.log("filtered: " + markers + ", needsEndMarker: " + needsEndMarker);
                                                    // We have a couple exceptions to the filter:
                                                    // - if the ending marker is in the same marker string, clear the filter flag
                                                    // - if there are markers before the filtered marker, export them
                                                    if ((needsEndMarker.length > 0) && (markers.indexOf(needsEndMarker) >= 0)) {
                                                        // found our ending marker -- this sourcephrase is not filtered
                                                        // first, remove the marker from the markers string so it doesn't print out
                                                        markers = markers.replace(("\\" + needsEndMarker), '');
                                                        // now clear our flags so the sourcephrase exports
                                                        needsEndMarker = "";
                                                        filtered = false;
                                                    } else {
                                                        markers = markers.substr(0, markers.indexOf(filterAry[idxFilters].trim()) - 1);
                                                        if (markers.length > 0) {
                                                            // some markers before we hit the filtered marker -- export them
                                                            exportMarkers = true;
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                                if ((needsEndMarker.length > 0) && (markers.indexOf(needsEndMarker) >= 0)) {
                                    // found our ending marker -- this sourcephrase is not filtered
                                    // first, remove the marker from the markers string so it doesn't print out
                                    markers = markers.replace(("\\" + needsEndMarker), '');
                                    // now clear our flags so the sourcephrase exports
                                    needsEndMarker = "";
                                    filtered = false;
                                }
                                if (filtered === false || exportMarkers === true) {
                                    // Export the markers
                                    if (markers.length > 0) {
                                        // EDB 5/28/21 updated marker export
                                        // we have one or more markers that aren't filtered;
                                        // split them out and deal with each one
                                        markerAry = markers.split("\\");
                                        console.log("EsportUSX - unfiltered markers: " + markerAry.length + " ("+ markers + ")");
                                        for (i = 1; i < markerAry.length; i++) {
                                            // each item is a marker [+ space + args]
                                            // extract the marker itself and look it up
                                            isEndMarker = (markerAry[i].indexOf('*') !== -1);
                                            if (markerAry[i].indexOf(' ') !== -1) {
                                                // we want just the marker for our USFM marker lookup
                                                strMarker = markerAry[i].substr(0, markerAry[i].indexOf(' '));
                                            } else {
                                                strMarker = markerAry[i]; // nothing to remove
                                            }
                                            if (isEndMarker) {
                                                strMarker = strMarker.substr(0, strMarker.length - 1); // remove trailing * for end marker
                                            }
                                            mkr = markerList.where({name: strMarker})[0];
                                            if (mkr) {
                                                strOptions = ""; // clear out the options param
                                                // what kind of a marker are we looking at?
                                                if (mkr.attributes.type === "note") { // <note>
                                                    if (tableBlockLevel > 0) {
                                                        // close out table tags
                                                        if (tableBlockLevel === 2) {
                                                            chapterString += "</cell>\n </row>\n<table>";
                                                            tableBlockLevel = 0;
                                                        } else {
                                                            chapterString += "\n </row>\n<table>";
                                                            tableBlockLevel = 0;
                                                        }
                                                    }
                                                    if (isEndMarker === true) {
                                                        // closing marker
                                                        chapterString += "</note>";
                                                    } else {
                                                        // opening marker
                                                        if (markerAry[i].indexOf(" ") !== -1) {
                                                            // has a caller -- pull it out
                                                            pos = markerAry[i].indexOf(" ") + 1;
                                                            if (markerAry[i].indexOf(" ", pos) !== -1) {
                                                                // there is a trailing space
                                                                strOptions += " caller=\"" + markerAry[i].substring(pos, (markerAry[i].indexOf(" ", pos))) + "\"";
                                                            } else {
                                                                // no trailing space
                                                                strOptions += " caller=\"" + markerAry[i].substring(pos) + "\"";
                                                            }
                                                        }
                                                        chapterString += "<note" + strOptions + " style=\"" + mkr.attributes.name + "\">";
                                                    }
                                                } else if (mkr.attributes.type === "book") { // <book>
                                                    if (mkr.attributes.name === "id") {
                                                        chapterString += "\n<book code=\"" + bookID + "\" style=\"id\">";
                                                    }
                                                    // USFM has no closing <book> marker, so we'll run until
                                                    // the next marker string. Set a flag so we know to close
                                                    // out the element (we'll handle it above)
                                                    isBookBlock = true;
                                                } else if (mkr.attributes.type === "xml") {
                                                    // special case (IDE block); ignore this here, because
                                                    // we'll add the IDE block when we close the <book> element
                                                } else if (mkr.attributes.type === "table") { // <table>/<row>/<cell>
                                                    // tables are only defined by table rows in USFM; if there
                                                    // have been other markers, start a new table
                                                    if (tableBlockLevel === 0) {
                                                        chapterString += "\n<table>";
                                                    }
                                                    if(mkr.attributes.name.indexOf("-") !== -1) {
                                                        // we have a spanning cell of some sort
                                                        pos = markers.indexOf("-") + 1;
                                                        strOptions += " colspan=\"" + markers.substring(pos, (markers.indexOf(" ", pos))) + "\"";
                                                    }
                                                    if (mkr.attributes.name === "tr") {
                                                        if (tableBlockLevel === 2) {
                                                            // cell level - close out old cell/row
                                                            chapterString += "</cell>\n </row>";
                                                        }
                                                        chapterString += "\n <row style=\"tr\">";
                                                        tableBlockLevel = 1; // row
                                                    } else if (mkr.attributes.name.indexOf("thr") !== -1) {
                                                        // header cell, right aligned
                                                        if (tableBlockLevel === 2) {
                                                            // cell level - close out old cell
                                                            chapterString += "</cell>";
                                                        }
                                                        tableBlockLevel = 2; // cell
                                                        chapterString += "\n  <cell style=\"" + mkr.attributes.name + "\"" + strOptions + " align=\"end\">";
                                                    } else if (mkr.attributes.name.indexOf("th") !== -1) {
                                                        // header cell, right aligned
                                                        if (tableBlockLevel === 2) {
                                                            // cell level - close out old cell
                                                            chapterString += "</cell>";
                                                        }
                                                        tableBlockLevel = 2; // cell
                                                        chapterString += "\n  <cell style=\"" + mkr.attributes.name + "\"" + strOptions + " align=\"start\">";
                                                    } else if (mkr.attributes.name.indexOf("tcr") !== -1) {
                                                        // header cell, right aligned
                                                        if (tableBlockLevel === 2) {
                                                            // cell level - close out old cell
                                                            chapterString += "</cell>";
                                                        }
                                                        tableBlockLevel = 2; // cell
                                                        chapterString += "\n  <cell style=\"" + mkr.attributes.name + "\"" + strOptions + " align=\"end\">";
                                                    } else if (mkr.attributes.name.indexOf("tc") !== -1) {
                                                        // header cell, right aligned
                                                        if (tableBlockLevel === 2) {
                                                            // cell level - close out old cell
                                                            chapterString += "</cell>";
                                                        }
                                                        tableBlockLevel = 2; // cell
                                                        chapterString += "\n  <cell style=\"" + mkr.attributes.name + "\"" + strOptions + " align=\"start\">";
                                                    }
                                                } else if (mkr.attributes.type === "sidebar") { 
                                                    if (tableBlockLevel > 0) {
                                                        // close out table tags
                                                        if (tableBlockLevel === 2) {
                                                            chapterString += "</cell>\n </row>\n<table>";
                                                            tableBlockLevel = 0;
                                                        } else {
                                                            chapterString += "\n </row>\n<table>";
                                                            tableBlockLevel = 0;
                                                        }
                                                    }
                                                    if (isParaBlock === true) {
                                                        // close out the old para
                                                        chapterString += "</para>";
                                                        isParaBlock = false;
                                                    }
                                                    if (mkr.attributes.name === "esbe") {
                                                        // closing sidebar
                                                        chapterString += "\n</sidebar>";
                                                    } else {
                                                        // opening sidebar
                                                        if (markers.indexOf("cat ") > -1) {
                                                            pos = markers.indexOf("cat ") + 5;
                                                            strOptions += " category=\"" + markers.substring(pos, (markers.indexof("\"", pos))) + "\"";
                                                        }
                                                        chapterString += "\n<sidebar style=\"esb\""+ strOptions + ">";
                                                    }
                                                } else if (mkr.attributes.type === "figure") { 
                                                    if (isEndMarker === true) {
                                                        // closing marker
                                                        chapterString += "</figure>";
                                                    } else {
                                                        // opening marker
                                                        // pull out the options: alt, src, size, loc, copy, ref
                                                        if (markerAry[i].indexOf("alt") !== -1) {
                                                            pos = markers.indexOf("alt") + 7;
                                                            strOptions += " alt=\"" + markers.substring(pos, (markers.indexOf("\"", pos))) + "\"";
                                                        }
                                                        if (markerAry[i].indexOf("src") !== -1) {
                                                            // Note: USX uses "file" for this attr name, not "src"
                                                            pos = markers.indexOf("src") + 7;
                                                            strOptions += " file=\"" + markers.substring(pos, (markers.indexOf("\"", pos))) + "\"";
                                                        }
                                                        if (markerAry[i].indexOf("size") !== -1) {
                                                            pos = markers.indexOf("size") + 7;
                                                            strOptions += " size=\"" + markers.substring(pos, (markers.indexOf("\"", pos))) + "\"";
                                                        }
                                                        if (markerAry[i].indexOf("loc") !== -1) {
                                                            pos = markers.indexOf("loc") + 7;
                                                            strOptions += " loc=\"" + markers.substring(pos, (markers.indexOf("\"", pos))) + "\"";
                                                        }
                                                        if (markerAry[i].indexOf("copy") !== -1) {
                                                            pos = markers.indexOf("copy") + 7;
                                                            strOptions += " copy=\"" + markers.substring(pos, (markers.indexOf("\"", pos))) + "\"";
                                                        }
                                                        if (markerAry[i].indexOf("ref") !== -1) {
                                                            pos = markers.indexOf("ref") + 7;
                                                            strOptions += " ref=\"" + markers.substring(pos, (markers.indexOf("\"", pos))) + "\"";
                                                        }
                                                        chapterString += "<figure style=\"fig\"" + strOptions + ">";
                                                    }
                                                } else if (mkr.attributes.type === "ref") { 
                                                    if (isEndMarker === true) {
                                                        // closing marker
                                                        chapterString += "</ref>";
                                                    } else {
                                                        // opening marker
                                                        if (markerAry[i].indexOf("loc") !== -1) {
                                                            pos = markers.indexOf("loc") + 7;
                                                            strOptions += " loc=\"" + markers.substring(pos, (markers.indexOf("\"", pos))) + "\"";
                                                        }
                                                        chapterString += "<ref" + strOptions + ">";
                                                    }
                                                } else if (mkr.attributes.type === "ms") {
                                                    if (markers.indexOf("\\ms-eid") > -1) {
                                                        // ms end (USX 3.x+) -
                                                        pos = markers.indexOf("ms-eid") + 8;
                                                        chapterString += "\n<ms eid=\"" + markers.substring(pos, (markers.indexOf(" ", pos))) + "\" />\n";
                                                    } else {
                                                        if (markers.indexOf("\\ms-sid") > -1) {
                                                            // ms start (USX 3.x+) -
                                                            pos = markers.indexOf("ms-sid") + 8;
                                                            strOptions += " sid=\"" + markers.substring(pos, (markers.indexOf(" ", pos))) + "\"";
                                                        }                                                        
                                                        if ((mkr.attributes.name.indexOf("qt") !== -1) && (markerAry[i].indexOf("who") !== -1)) {
                                                            // found a "who" param -- add it to strOptions
                                                            pos = markers.indexOf("who") + 7;
                                                            strOptions += " who=\"" + markers.substring(pos, (markers.indexOf("\"", pos))) + "\"";
                                                        }
                                                        // ms-sid
                                                        chapterString += "\n<ms style=\"" + strMarker + "\"" + strOptions + " />";
                                                    }
                                                } else if (mkr.attributes.type === "periph") {
                                                    if (tableBlockLevel > 0) {
                                                        // close out table tags
                                                        if (tableBlockLevel === 2) {
                                                            chapterString += "</cell>\n </row>\n<table>";
                                                            tableBlockLevel = 0;
                                                        } else {
                                                            chapterString += "\n </row>\n<table>";
                                                            tableBlockLevel = 0;
                                                        }
                                                    }
                                                    if (isParaBlock === true) {
                                                        // close out the old para
                                                        chapterString += "</para>";
                                                        isParaBlock = false;
                                                    }
                                                    if (isPeriphBlock === true) {
                                                        // close out old periph block
                                                        chapterString += "\n  </periph>";
                                                    }
                                                    isPeriphBlock = true; // now inside a periph block
                                                    pos = markers.indexOf("periph") + 9;
                                                    strOptions += " alt=\"" + markers.substring(pos, (markers.indexOf("|", pos))) + "\"";
                                                    pos = markers.indexOf("id=") + 5;
                                                    strOptions += " id=\"" + markers.substring(pos, (markers.indexOf("\"", pos))) + "\"";
                                                    chapterString += "\n  <periph" + strOptions + ">";
                                                } else if (mkr.attributes.type === "char") {
                                                    // char elements usually have a closing *, which we flag
                                                    // with isEndMarker=true. Check for it now.
                                                    if (isEndMarker === true) {
                                                        // closing <char> marker
                                                        chapterString += "</char>";
                                                    } else {
                                                        // opening <char> marker - first, pull out any options
                                                        // wordlist options
                                                        if (mkr.attributes.name.indexOf("w") !== -1) {
                                                            if (markerAry[i].indexOf("lemma") !== -1) {
                                                                pos = markers.indexOf("lemma") + 7;
                                                                strOptions += " lemma=\"" + markers.substring(pos, (markers.indexOf("\"", pos))) + "\"";
                                                            }
                                                            if (markerAry[i].indexOf("strong") !== -1) {
                                                                pos = markers.indexOf("strong") + 8;
                                                                strOptions += " strong=\"" + markers.substring(pos, (markers.indexOf("\"", pos))) + "\"";
                                                            }
                                                            if (markerAry[i].indexOf("srcloc") !== -1) {
                                                                pos = markers.indexOf("srcloc") + 9;
                                                                strOptions += " srcloc=\"" + markers.substring(pos, (markers.indexOf("\"", pos))) + "\"";
                                                            }
                                                        }
                                                        // ruby annotation options
                                                        if ((mkr.attributes.name.indexOf("rb ") !== -1) && (markerAry[i].indexOf("|gloss") !== -1)) {
                                                            pos = markers.indexOf("gloss") + 8;
                                                            strOptions += " gloss=\"" + markers.substring(pos, (markers.indexOf("\"", pos))) + "\"";

                                                        }
                                                        // link options (USX 3.x)
                                                        if (markerAry[i].indexOf("z-link-href") !== -1) {
                                                            pos = markers.indexOf("link-href") + 12;
                                                            strOptions += " link-href=\"" + markers.substring(pos, (markers.indexOf("\"", pos))) + "\"";
                                                        }
                                                        if (markerAry[i].indexOf("z-link-title") !== -1) {
                                                            pos = markers.indexOf("link-title") + 13;
                                                            strOptions += " link-title=\"" + markers.substring(pos, (markers.indexOf("\"", pos))) + "\"";
                                                        }
                                                        if (markerAry[i].indexOf("z-link-id") !== -1) {
                                                            pos = markers.indexOf("link-id") + 10;
                                                            strOptions += " link-id=\"" + markers.substring(pos, (markers.indexOf("\"", pos))) + "\"";
                                                        }
                                                        // now emit the <char> node
                                                        chapterString += "<char style=\"" + strMarker + strOptions + "\">";
                                                    }
                                                } else if (mkr.attributes.type === "verse") { // <verse>
                                                    if (markers.indexOf("\\v-eid ") > -1) {
                                                        // verse end (USX 3.x+) -
                                                        pos = markers.indexOf("\\v-eid ") + 8;
                                                        chapterString += "<verse eid=\"" + markers.substring(pos, (markers.indexOf(" ", pos))) + "\" />";
                                                    } else {
                                                        // verse start
                                                        chapterString += "\n<verse number=\"";
                                                        pos = markers.indexOf("\\v ") + 3;
                                                        if (markers.indexOf(" ", pos) > -1) {
                                                            chapterString += markers.substring(pos, (markers.indexOf(" ", pos)));
                                                        } else {
                                                            chapterString += markers.substr(pos);
                                                        }
                                                        chapterString += "\" style=\"v";
                                                        if (markers.indexOf("\\vp") > -1) {
                                                            // publishing numbering
                                                            pos = markers.indexOf("\\vp") + 3;
                                                            chapterString += "\" pubnumber=\"";
                                                            if (markers.indexOf("\\", pos) < 0) {
                                                                chapterString += markers.substr(pos + 1);
                                                            } else {
                                                                chapterString += markers.substr(pos + 1, (markers.indexOf("\\", pos + 1) - (pos + 1)));
                                                            }
                                                        }
                                                        if (markers.indexOf("\\va") > -1) {
                                                            // alternate numbering
                                                            pos = markers.indexOf("\\va") + 3;
                                                            chapterString += "\" altnumber=\"";
                                                            if (markers.indexOf("\\", pos) < 0) {
                                                                chapterString += markers.substr(pos + 1);
                                                            } else {
                                                                chapterString += markers.substr(pos + 1, (markers.indexOf("\\", pos + 1) - (pos + 1)));
                                                            }
                                                        }
                                                        if (markers.indexOf("\\v-sid ") > -1) {
                                                            // verse ID (USX 3.x+)
                                                            pos = markers.indexOf("\\v-sid ") + 8;
                                                            chapterString += "\" sid=\"";
                                                            if (markers.indexOf("\\", pos + 1) < 0) {
                                                                chapterString += markers.substr(pos + 2);
                                                            } else {
                                                                chapterString += markers.substr(pos + 2, (markers.indexOf("\\", pos + 1) - (pos + 2)));
                                                            }
                                                        }
                                                        chapterString += "\" />";
                                                    }
                                                } else if (mkr.attributes.type === "chapter") { // <chapter>
                                                    if (tableBlockLevel > 0) {
                                                        // close out table tags
                                                        if (tableBlockLevel === 2) {
                                                            chapterString += "</cell>\n </row>\n<table>";
                                                            tableBlockLevel = 0;
                                                        } else {
                                                            chapterString += "\n </row>\n<table>";
                                                            tableBlockLevel = 0;
                                                        }
                                                    }
                                                    if (isParaBlock === true) {
                                                        // close out the old para
                                                        chapterString += "</para>";
                                                        isParaBlock = false;
                                                    }
                                                    if (markers.indexOf("\\c-eid ") > -1) {
                                                        // chapter end (USX 3.x+) -
                                                        pos = markers.indexOf("\\c-eid ") + 8;
                                                        chapterString += "\n<chapter eid=\"" + markers.substring(pos, (markers.indexOf(" ", pos))) + "\" />";
                                                    } else {
                                                        // chapter start
                                                        chapterString += "\n<chapter number=\"";
                                                        pos = markers.indexOf("\\c ") + 3;
                                                        if (markers.indexOf(" ", pos) > -1) {
                                                            chapterString += markers.substring(pos, (markers.indexOf(" ", pos)));
                                                        } else {
                                                            chapterString += markers.substr(pos);
                                                        }
                                                        chapterString += "\" style=\"c";
                                                        if (markers.indexOf("\\cp") > -1) {
                                                            // publishing numbering
                                                            pos = markers.indexOf("\\cp") + 3;
                                                            chapterString += "\" pubnumber=\"";
                                                            if (markers.indexOf("\\", pos) < 0) {
                                                                chapterString += markers.substr(pos + 1);
                                                            } else {
                                                                chapterString += markers.substr(pos + 1, (markers.indexOf("\\", pos + 1) - (pos + 1)));
                                                            }
                                                        }
                                                        if (markers.indexOf("\\ca") > -1) {
                                                            // alternate numbering
                                                            pos = markers.indexOf("\\ca") + 3;
                                                            chapterString += "\" altnumber=\"";
                                                            if (markers.indexOf("\\", pos) < 0) {
                                                                chapterString += markers.substr(pos + 1);
                                                            } else {
                                                                chapterString += markers.substr(pos + 1, (markers.indexOf("\\", pos + 1) - (pos + 1)));
                                                            }
                                                        }
                                                        if (markers.indexOf("\\c-sid ") > -1) {
                                                            // chapter ID (USX 3.x+)
                                                            pos = markers.indexOf("\\c-sid ") + 8;
                                                            chapterString += "\" sid=\"";
                                                            if (markers.indexOf("\\", pos + 1) < 0) {
                                                                chapterString += markers.substr(pos + 2);
                                                            } else {
                                                                chapterString += markers.substr(pos + 2, (markers.indexOf("\\", pos + 1) - (pos + 2)));
                                                            }
                                                        }
                                                        chapterString += "\" />";
                                                    }
                                                } else {
                                                    // default type => para
                                                    if (tableBlockLevel > 0) {
                                                        // close out table tags
                                                        if (tableBlockLevel === 2) {
                                                            chapterString += "</cell>\n </row>\n<table>";
                                                            tableBlockLevel = 0;
                                                        } else {
                                                            chapterString += "\n </row>\n<table>";
                                                            tableBlockLevel = 0;
                                                        }
                                                    }
                                                    if (markerAry[i].indexOf("vid") !== -1) {
                                                        pos = markers.indexOf("") + 6;
                                                        strOptions += " vid=\"" + markers.substring(pos, (markers.indexOf("\"", pos))) + "\"";
                                                    }
                                                    if (isParaBlock === true) {
                                                        // close out the old para before starting another
                                                        chapterString += "</para>";
                                                    }
                                                    isParaBlock = true;
                                                    chapterString += "\n<para style=\"" + mkr.attributes.name + strOptions + "\">";
                                                }
                                            } else {
                                                // no marker found (Is this a valid marker? Is it too new/too old? ) -- dump as a comment
                                                chapterString += "\n<!-- MARKER NOT FOUND:" + markerAry[i] + " -->";
                                            }
                                        }
                                    }
                                    if (exportMarkers === true) {
                                        // done exporting the marker subset before the filtered marker -- clear our flag
                                        exportMarkers = false;
                                    }
                                    if (filtered === false) {
                                        // only export the text if not filtered AND
                                        // only emit soursephrase pre/foll puncts if we have something translated in the target
                                        if (value.get("source").length > 0 && value.get("target").length > 0) {
                                            // special case -- optional break
                                            // (not a traditional USFM "marker")
                                            if (value.get("target") === "//") {
                                                chapterString += "<optbreak />";
                                            } else {
                                                chapterString += value.get("target") + " ";
                                            }
                                        }
                                    }
                                }
                                // done dealing with the source phrase -- is it the last one?
                                if (value.get('spid') === lastSPID) {
                                    // last phrase -- exit
                                    console.log("Found last SPID: " + lastSPID);
                                    break;
                                }
                            }
                            // Now take the string from this chapter's sourcephrases that we've just built and
                            // insert them into the correct location in the file's strContents string
                            strContents = strContents.replace(("**" + entry.get("chapterid") + "**"), chapterString);
                            // decrement the chapter count, closing things out if needed
                            chaptersLeft--;
                            if (chaptersLeft === 0) {
                                console.log("finished within sp block");
                                // done with the chapters
                                // add a closing paragraph if necessary
                                if (closeNode.length > 0) {
                                    strContents += closeNode;
                                }
                                if (tableBlockLevel > 0) {
                                    // close out table tags
                                    if (tableBlockLevel === 2) {
                                        strContents += "</cell>\n </row>\n<table>";
                                        tableBlockLevel = 0;
                                    } else {
                                        strContents += "\n </row>\n<table>";
                                        tableBlockLevel = 0;
                                    }
                                }
                                if (isParaBlock === true) {
                                    // close out the old para
                                    strContents += "</para>";
                                    isParaBlock = false;
                                }
                                if (isPeriphBlock === true) {
                                    // close out old periph block
                                    strContents += "\n  </periph>";
                                }
                                // add the ending node
                                strContents += "\n</usx>\n";
                                // done writing out strContents string -- return
                                return;
                            }
                        });
                    } else {
                        // BUGBUG: can we end up here if there are chapters?
                        // no sourcephrases to export -- just decrement the chapters, and close things out if needed
                        chaptersLeft--;
                        if (chaptersLeft === 0) {
                            console.log("finished in a blank block");
                            // done with the chapters
                            // add a closing paragraph if necessary
                            if (closeNode.length > 0) {
                                strContents += closeNode;
                            }
                            if (tableBlockLevel > 0) {
                                // close out table tags
                                if (tableBlockLevel === 2) {
                                    strContents += "</cell>\n </row>\n<table>";
                                    tableBlockLevel = 0;
                                } else {
                                    strContents += "\n </row>\n<table>";
                                    tableBlockLevel = 0;
                                }
                            }
                            if (isParaBlock === true) {
                                // close out the old para
                                strContents += "</para>";
                                isParaBlock = false;
                            }
                            if (isPeriphBlock === true) {
                                // close out periph block
                                strContents += "\n  </periph>";
                            }
                            // add the ending node
                            strContents += "\n</usx>\n";
                            // done writing content string -- return
                            return;
                        }
                    }
                });
                if (strContents === "") {
                    // didn't export anything
                    exportFail(new Error(i18n.t('view.dscErrNothingToExport')));
                    return false;
                } else {
                    // success
                    return true;
                }
            };

            // XML document
            // Note that this export is a full dump of the document, not just the parts that have been adapted.
            // This is because we're exporting the source as well as the target text.
            // EDB 8/13/16: partially working. Still need:
            // - ~FILTER text folded in
            // -- lower priority, but need for AI compatibility: other bits implemented
            var buildAIDocXML = function () {
                var chapters = window.Application.ChapterList.where({bookid: bookid});
                var markerList = new USFM.MarkerCollection();
                var filterAry = window.Application.currentProject.get('FilterMarkers').split("\\");
                var words = [];
                var XML_PROLOG = "<?xml version=\"1.0\" encoding=\"utf-8\" standalone=\"yes\"?>";
                var spList = new spModel.SourcePhraseCollection();
                var markers = "";
                var filtered = false;
                var needsEndMarker = "";
                var cNum = "";
                var vNum = "";
                var i = 0;
                var idxFilters = 0;
                var sn = 0;
                var fi = "";
                var curTY = "2";
                var lastTY = "2";
                var value = null;
                var mkr = null;
                var atts = {
                    name: [],
                    value: []
                };
                var project = window.Application.currentProject;
                var chaptersLeft = chapters.length;
                var hexToWXColor = function (color) {
                    // AIM (.html) --> #rrggbb  (in hex)
                    // Adapt It  --> 0x00bbggrr (in base 10)
                    console.log("hexToWXColor - input: " + color);
                    var result = "0x00";
                    result += color.substr(5, 2); // bb
                    result += color.substr(3, 2); // gg
                    result += color.substr(1, 2); // rr
                    var tmpInt = parseInt(result, 16);
                    result = tmpInt.toString(10);
                    console.log("hexToWXColor - output: " + result);
                    return result;
                };
                var buildFlags = function (sourcephrase) {
                    var markers = sourcephrase.get("markers");
                    // (code in XML.cpp ~ line 5568)
                    var val = "";
                    val += "0"; // unused (22)
                    val += (markers.indexOf("\\f*") >= 0) ? "1" : "0"; // footnote end (21)
                    val += (markers.indexOf("\\f ") >= 0) ? "1" : "0"; // footnote (20)
                    val += "00"; // internal markers / punctuation (19/18)
                    val += (markers.indexOf("\\c ") >= 0) ? "1" : "0"; // chapter mask (17)
                    val += (markers.indexOf("\\v ") >= 0) ? "1" : "0"; // verse mask (16)
                    val += "0"; // sectionByVerse (15)
                    val += (markers.indexOf("\\n ") >= 0) ? "1" : "0"; // note mask (14)
                    val += "000"; // free translation masks (11-13)
                    val += "000"; // retranslation masks (8-10)
                    val += "0"; // null source phrase (7)
                    val += "00"; // boundary masks (5-6)
                    val += (markers.indexOf("\\s ") >= 0) ? "1" : "0"; // special text (4)
                    val += "0"; // glossing KB entry (3)
                    val += "00"; // KB entries (1-2)
                    //val += (sourcephrase.get)
                    return val;
                };
                var buildTY = function (sourcephrase, lastTY) {
                    console.log("buildTY");
                    // (code in SourcePhrase.h ~ line 55 / CAdaptIt_Doc.cpp - line 18859)
                    var val = (lastTY.length > 0) ? lastTY : "1"; // default -- last type (verse if not there)
                    var markers = sourcephrase.get("markers");
                    if (markers.indexOf("\\v ") >= 0) {
                        val = "1"; // verse
                    }
                    if (markers.indexOf("\\p ") >= 0) {
                        val = "2"; // poetry
                    }
                    if (markers.indexOf("\\s ") >= 0) {
                        val = "3"; // section head
                    }
                    if ((markers.indexOf("\\mt2") >= 0) || (markers.indexOf("\\mt3") >= 0) || (markers.indexOf("\\mt4") >= 0)) {
                        val = "4"; // secondary title
                    }
                    if (markers.indexOf("\\f ") >= 0) {
                        // ord, bd, it, em, bdit, sc, pro, ior, w, wr, wh, wg, ndx, k, pn, qs, fk, xk
                        val = "6"; // none
                    }
                    if (markers.indexOf("\\f ") >= 0) {
                        val = "9"; // footnote
                    }
                    if ((markers.indexOf("\\h2") >= 0) || (markers.indexOf("\\h3") >= 0) || (markers.indexOf("\\h4") >= 0)) {
                        val = "10"; // header
                    }
                    if (markers.indexOf("\\id") >= 0) {
                        val = "11"; // identification
                    }
                    if (markers.indexOf("\\ref ") >= 0) {
                        val = "32"; // right Margin reference
                    }
                    if (markers.indexOf("\\cr ") >= 0) {
                        val = "33"; // cross reference
                    }
                    if (markers.indexOf("\\n ") >= 0) {
                        val = "34"; // note
                    }
                    return val;
                };
                // build the USFM marker list
                markerList.fetch({reset: true, data: {name: ""}});
                console.log("markerList count: " + markerList.length);
                // opening strContents
                strContents = XML_PROLOG;
                strContents += "\n<!--\n     Note: Using Microsoft WORD 2003 or later is not a good way to edit this xml file.\n     Instead, use NotePad or WordPad. -->\n<AdaptItDoc>\n";
                // Settings: AIM doesn't do per-document settings; just copy over the project settings
                strContents += "<Settings docVersion=\"9\" bookName=\"" + bookName + "\" owner=\"";
                if (device && (device.platform !== "browser")) {
                    strContents += device.uuid;
                } else {
                    strContents += "Browser";
                }
                strContents += "\" commitcnt=\"****\" revdate=\"\" actseqnum=\"0\" sizex=\"553\" sizey=\"62464\" ftsbp=\"1\"";
                // colors
                strContents += " specialcolor=\"" + hexToWXColor(project.get('SpecialTextColor')) + "\" retranscolor=\"" + hexToWXColor(project.get('RetranslationColor')) + "\" navcolor=\"" + hexToWXColor(project.get('NavigationColor')) + "\"";
                // project info
                strContents += " curchap=\"1:\" srcname=\"" + project.get('SourceLanguageName') + "\" tgtname=\"" + project.get('TargetLanguageName') + "\" srccode=\"" + project.get('SourceLanguageCode') + "\" tgtcode=\"" + project.get('TargetLanguageCode') + "\"";
                // filtering
                strContents += " others=\"@#@#:F:-1:0:";
                strContents += project.get('FilterMarkers');
                strContents += "::\"/>\n";
                // END settings xml node
                // strContents PART: get the chapters belonging to our book
                chapters.forEach(function (entry) {
                    // add a placeholder string for this chapter, so that it ends up in order (the call to
                    // fetch() is async, and sometimes the chapters are returned out of order)
                    strContents += "**" + entry.get("chapterid") + "**";
                    // for each chapter (regardless of whether there's some adaptation done), get the sourcephrases
                    spList.fetch({reset: true, data: {chapterid: entry.get("chapterid")}}).done(function () {
                        var chapterString = "";
                        var addLF = false;
                        for (i = 0; i < spList.length; i++) {
                            value = spList.at(i);
                            markers = value.get("markers");
                            // before we begin -- do some checks for filtered sourcephrases
                            // With the XML export, filtered text is exported in the "fi" attribute. We'll collect all the filtered
                            // text and markers in that attribute, and then export the attribute with the first non-filtered string.
                            if (filtered === true && markers.length > 0 && needsEndMarker.length === 0) {
                                // hit the next strip; this is an implicit end to the filtering (there's no end marker)
                                filtered = false;
                                fi += " \\~FILTER*";
                            }
                            // check to see if this sourcephrase is filtered (only looking at the top level)
                            if (filtered === false) {
                                for (idxFilters = 0; idxFilters < filterAry.length; idxFilters++) {
                                    // sanity check for blank filter strings
                                    if (filterAry[idxFilters].trim().length > 0) {
                                        if (markers.indexOf(filterAry[idxFilters].trim()) >= 0) {
                                            // this is a filtered sourcephrase -- do not export it; add it to the "fi" variable
                                            // if there is an end marker associated with this marker,
                                            // do not export any source phrases until we come across the end marker
                                            mkr = markerList.where({name: filterAry[idxFilters].trim()});
                                            if (mkr[0].get("endMarker")) {
                                                needsEndMarker = mkr[0].get("endMarker");
                                            }
                                            filtered = true;
                                            fi = "\\~FILTER ";
                                            console.log("filtered: " + markers + ", needsEndMarker: " + needsEndMarker);
                                            // We have a couple exceptions to the filter:
                                            // - if the ending marker is in the same marker string, clear the filter flag
                                            // - if there are markers before the filtered marker, export them
                                            if ((needsEndMarker.length > 0) && (markers.indexOf(needsEndMarker) >= 0)) {
                                                // found our ending marker -- this sourcephrase is not filtered
                                                // first, remove the marker from the markers string so it doesn't print out
                                                markers = markers.replace(("\\" + needsEndMarker), '');
                                                // now clear our flags so the sourcephrase exports
                                                needsEndMarker = "";
                                                filtered = false;
                                                // build the rest of the fi string
                                                fi += markers + value.get("prepuncts") + value.get("source") + value.get("follpuncts") + " \\~FILTER*";
                                            }
                                        }
                                    }
                                }
                            }
                            if ((needsEndMarker.length > 0) && (markers.indexOf(needsEndMarker) >= 0)) {
                                // found our ending marker
                                // add this sourcephrase to the filter string, with the end marker last (with no space before it)
                                fi += value.get("prepuncts") + value.get("source") + value.get("follpuncts") + markers + " " + "\\~FILTER*";
                                // clear our flags so the next sourcephrase exports
                                needsEndMarker = "";
                                filtered = false;
                                continue;
                            }
                            if (filtered === true) {
                                // add this sourcephrase to the filter string
                                fi += markers + " " + value.get("prepuncts") + value.get("source") + value.get("follpuncts") + " ";
                            }
                            if (filtered === false) {
                                // format for <S> nodes found in CSourcePhrase::MakeXML (SourcePhrase.cpp)
                                // line 1 -- source, key, target, adaptation
                                chapterString += "<S s=\"";
                                if (value.get("prepuncts").length > 0) {
                                    chapterString += Underscore.escape(value.get("prepuncts"));
                                }
                                chapterString += value.get("source");
                                if (value.get("follpuncts").length > 0) {
                                    chapterString += Underscore.escape(value.get("follpuncts"));
                                }
                                chapterString += "\" k=\"" + value.get("source") + "\"";
                                if (value.get("target").length > 0) {
                                    chapterString += " t=\"" + value.get("target") + "\" a=\"";
                                    if (value.get("follpuncts").length > 0) {
                                        // the "a" attribute does not include following punctuation
                                        chapterString += value.get("target").substr(0, value.get("target").indexOf(value.get("follpuncts")));
                                    } else {
                                        chapterString += value.get("target");
                                    }
                                    // extract any trailiing punct for the "a" attribute
                                    chapterString += "\"";
                                }
                                // line 2 -- flags, sequNumber, SrcWords, TextType
                                chapterString += "\n f=\"";
                                if (value.get("flags").length > 0) {
                                    chapterString += value.get("flags");
                                } else {
                                    chapterString += buildFlags(value);
                                }
                                chapterString += "\" sn=\"" + sn;
                                sn++; // increment our counter
                                words = value.get("source").match(/\S+/g);
                                if (words) {
                                    chapterString += "\" w=\"" + words.length + "\"";
                                } else {
                                    chapterString += "\" w=\"1\"";
                                }
                                if (value.get("srcwordbreak").length > 0) {
                                    // this doc was imported from AI -- just copy over the existing ty value
                                    curTY = value.get("texttype");
                                } else {
                                    // this doc didn't come form AI -- need to build the ty value
                                    curTY = buildTY(value, lastTY);
                                }
                                chapterString += " ty=\"" + curTY + "\"";
                                lastTY = curTY; // for the next item
                                // line 3 -- 6 atts (optional)
                                addLF = true;
                                if (value.get("prepuncts").length > 0) {
                                    if (addLF === true) {
                                        chapterString += "\n";
                                        addLF = false;
                                    }
                                    chapterString += " pp=\"" + Underscore.escape(value.get("prepuncts")) + "\"";
                                }
                                if (value.get("follpuncts").length > 0) {
                                    if (addLF === true) {
                                        chapterString += "\n";
                                        addLF = false;
                                    }
                                    chapterString += " fp=\"" + Underscore.escape(value.get("follpuncts")) + "\"";
                                }
                                // inform marker
                                var markerAry = markers.split("\\");
                                var idxMkr = 0;
                                var inform = markers;
                                for (idxMkr = 0; idxMkr < markerAry.length; idxMkr++) {
                                    // sanity check for blank filter strings
                                    if ((markerAry[idxMkr].trim().length > 0) && markerAry[idxMkr].trim() !== "p") {
                                        mkr = markerList.where({name: markerAry[idxMkr].trim()})[0];
                                        if (mkr && mkr.get('inform') === "1") {
                                            if (mkr.get('navigationText')) {
                                                inform = mkr.get('navigationText');
                                            }
                                            if (addLF === true) {
                                                chapterString += "\n";
                                                addLF = false;
                                            }
                                            chapterString += " i=\"" + inform + "\"";
                                        }
                                    }
                                }
                                if (markers.indexOf("\\v") > -1) {
                                    if (addLF === true) {
                                        chapterString += "\n";
                                        addLF = false;
                                    }
                                    if (markers.indexOf(" ", markers.indexOf("\\v") + 3) > 0) {
                                        // embedded verse number -- go to the next space
                                        vNum = markers.substr(markers.indexOf("\\v") + 3, markers.indexOf(" ", markers.indexOf("\\v") + 3)).trim();
                                    } else {
                                        // last marker -- just take the rest of the string
                                        vNum = markers.substr(markers.indexOf("\\v") + 3);
                                    }
                                    cNum = entry.get("name").substr(entry.get("name").lastIndexOf(" ") + 1);
                                    // add chapter/verse (c:v)
                                    chapterString += " c=\"" + cNum + ":" + vNum + "\"";
                                }
                                // line 4 -- markers, end markers, inline binding markers, inline binding end markers,
                                //           inline nonbinding markers, inline nonbinding end markers
                                addLF = true;
                                if (markers.length > 0) {
                                    if (addLF === true) {
                                        chapterString += "\n";
                                        addLF = false;
                                    }
                                    chapterString += "m=\"" + markers + "\"";
                                }
                                // line 5-8 -- free translation, note, back translation, filtered info
                                addLF = true;
                                if (value.get("freetrans").length > 0) {
                                    if (addLF === true) {
                                        chapterString += "\n";
                                        addLF = false;
                                    }
                                    chapterString += "ft=\"" + value.get("freetrans") + "\"";
                                }
                                addLF = true;
                                if (value.get("note").length > 0) {
                                    if (addLF === true) {
                                        chapterString += "\n";
                                        addLF = false;
                                    }
                                    chapterString += "no=\"" + value.get("note") + "\"";
                                }
                                addLF = true;
                                if (fi.length > 0) {
                                    if (addLF === true) {
                                        chapterString += "\n";
                                        addLF = false;
                                    }
                                    chapterString += "fi=\"" + Underscore.escape(fi) + "\"";
                                    fi = ""; // clear out filter string
                                }
                                // line 9 -- lapat, tmpat, gmpat, pupat
                                // chapterString += ">";
                                // 3 more possible info types
                                // medial puncts, medial markers, saved words (another <s>)
                                if (value.get("midpuncts").length > 0) {
                                    chapterString += "\n<MP mp=\"" + value.get("midpuncts") + "\"/>";
                                }
                                // line 10 -- source word break (swbk), target word break (twbk)
                                addLF = true;
                                if (value.get("srcwordbreak").length > 0) {
                                    if (addLF === true) {
                                        chapterString += "\n";
                                        addLF = false;
                                    }
                                    chapterString += "swbk=\"" + value.get("srcwordbreak") + "\"";
                                }
                                if (value.get("tgtwordbreak").length > 0) {
                                    if (addLF === true) {
                                        chapterString += "\n";
                                        addLF = false;
                                    }
                                    chapterString += "twbk=\"" + value.get("tgtwordbreak") + "\"";
                                }
                                chapterString += ">";
                                chapterString += "\n</S>\n";
                            }
                        }
                        // Now take the string from this chapter's sourcephrases that we've just built and
                        // insert them into the correct location in the file's strContents string
                        strContents = strContents.replace(("**" + entry.get("chapterid") + "**"), chapterString);
                        chaptersLeft--;
                        if (chaptersLeft === 0) {
                            // done with the chapters -- add the ending node
                            strContents += "</AdaptItDoc>\n";
                            // done writing the content string -- return
                            return;
                        }
                    });
                });
                if (strContents === "") {
                    // didn't export anything
                    exportFail(new Error(i18n.t('view.dscErrNothingToExport')));
                    return false;
                } else {
                    // success
                    return true;
                }
            };
            // ** end Doc formats

            // ------------------
            // ** KB FORMATS
            // buildGlossKB
            // AI glossing KB XML file format
            var buildGlossKB = function () {
                var XML_PROLOG = "<?xml version=\"1.0\" encoding=\"utf-8\" standalone=\"yes\"?>";
                var i = 0;
                var mn = 1;
                var refstrings = null;
                var CRLF = "\r\n"; // windows line ending (carriage return + line feed)
                var project = window.Application.currentProject;
                kblist.comparator = function (model) {
                    return (model.get("mn") && (model.get("isGloss") === 1));
                };
                kblist.sort();
                // opening strContents
                strContents = XML_PROLOG;
                strContents += CRLF + "<!--" + CRLF + "     Note: Using Microsoft WORD 2003 or later is not a good way to edit this xml file." + CRLF + "     Instead, use NotePad or WordPad. -->" + CRLF;
                // KB line -- project info
                // (Note that we are including scrCode, which is not included in the Glossing.xml file that AI exports at the moment)
                strContents += "<KB kbVersion=\"3\" srcName=\"" + project.get('SourceLanguageName') + "\" tgtName=\"" + project.get('TargetLanguageName') + "\" srcCode=\"" + project.get('SourceLanguageCode') + "\" max=\"" + kblist.at(kblist.length - 1).get('mn') + "\" glossingKB=\"1\">" + CRLF;
                // END settings xml node
                // strContents PART: target units, sorted by MAP number (words in string / "mn" in the attributes)
                strContents += "     <MAP mn=\"1\">" + CRLF; // starting MAP node
                kblist.forEach(function (tu) {
                    if (tu.get('source') === "**ImportedKBFile**") {
                        // skip this entry -- this is our internal "imported KB file" flag
                        return; // continue
                    }
                    if (tu.get('isGloss') === 0) {
                        // non-gloss KB element -- skip
                        return; // continue
                    }
                    // did the map number change? If so, emit a new <MAP> element
                    if (tu.get('mn') > mn) {
                        // create a new MAP element
                        strContents += "     </MAP>" + CRLF + "     <MAP mn=\"" + tu.get('mn') + "\">" + CRLF;
                        mn = tu.get('mn'); // update the map #
                    }
                    // create the <TU> element
                    strContents += "     <TU f=\"" + tu.get('f') + "\" k=\"" + tu.get('source') + "\">" + CRLF;
                    // create any refstring elements
                    refstrings = tu.get('refstring');
                    // sort the refstrings on "n" (refcount)
                    refstrings.sort(function (a, b) {
                        // high to low
                        return parseInt(b.n, 10) - parseInt(a.n, 10);
                    });
                    // write them out
                    for (i = 0; i < refstrings.length; i++) {
                        strContents += "       <RS n=\"" + refstrings[i].n + "\" a=\"" + refstrings[i].target + "\" df=\"" + refstrings[i].df + "\"" + CRLF + "       cDT=\"" + refstrings[i].cDT + "\" wC=\"" + refstrings[i].wC + "\"";
                        if (refstrings[i].mDT || refstrings[i].dDT) {
                            // optional datetime info
                            strContents += CRLF + "       ";
                            if (refstrings[i].mDT) {
                                strContents += " mDT=\"" + refstrings[i].mDT + "\"";
                            }
                            if (refstrings[i].dDT) {
                                strContents += " dDT=\"" + refstrings[i].dDT + "\"";
                            }
                        }
                        strContents += "/>" + CRLF;
                    }
                    strContents += "     </TU>" + CRLF;
                });
                // done strContents PART -- close out the file
                strContents += "     </MAP>" + CRLF + "</KB>" + CRLF;
                if (strContents === "") {
                    // didn't export anything
                    exportFail(new Error(i18n.t('view.dscErrNothingToExport')));
                    return false;
                } else {
                    // success
                    return true;
                }
            };

            // buildKBXML
            // AI knowledge base XML file export
            var buildKBXML = function () {
                var XML_PROLOG = "<?xml version=\"1.0\" encoding=\"utf-8\" standalone=\"yes\"?>";
                var i = 0;
                var mn = 1;
                var refstrings = null;
                var CRLF = "\r\n"; // windows line ending (carriage return + line feed)
                var project = window.Application.currentProject;
                kblist.comparator = function (model) {
                    return model.get("mn");
                };
                kblist.sort();
                // opening content
                strContents = XML_PROLOG;
                strContents += CRLF + "<!--" + CRLF + "     Note: Using Microsoft WORD 2003 or later is not a good way to edit this xml file." + CRLF + "     Instead, use NotePad or WordPad. -->" + CRLF;
                // KB line -- project info
                strContents += "<KB kbVersion=\"3\" srcName=\"" + project.get('SourceLanguageName') + "\" tgtName=\"" + project.get('TargetLanguageName') + "\" srcCode=\"" + project.get('SourceLanguageCode') + "\" tgtCode=\"" + project.get('TargetLanguageCode') + "\" max=\"" + kblist.at(kblist.length - 1).get('mn') + "\" glossingKB=\"0\">" + CRLF;
                // END settings xml node
                // strContents PART: target units, sorted by MAP number (words in string / "mn" in the attributes)
                strContents += "     <MAP mn=\"1\">" + CRLF; // starting MAP node
                kblist.forEach(function (tu) {
                    if (tu.get('source') === "**ImportedKBFile**") {
                        // skip this entry -- this is our internal "imported KB file" flag
                        return; // continue
                    }
                    if (tu.get('isGloss') === 1) {
                        // gloss KB element -- skip
                        return; // continue
                    }
                    // did the map number change? If so, emit a new <MAP> element
                    if (tu.get('mn') > mn) {
                        // create a new MAP element
                        strContents += "     </MAP>" + CRLF + "     <MAP mn=\"" + tu.get('mn') + "\">" + CRLF;
                        mn = tu.get('mn'); // update the map #
                    }
                    // create the <TU> element
                    strContents += "     <TU f=\"" + tu.get('f') + "\" k=\"" + tu.get('source') + "\">" + CRLF;
                    // create any refstring elements
                    refstrings = tu.get('refstring');
                    // sort the refstrings on "n" (refcount)
                    refstrings.sort(function (a, b) {
                        // high to low
                        return parseInt(b.n, 10) - parseInt(a.n, 10);
                    });
                    // write them out
                    for (i = 0; i < refstrings.length; i++) {
                        strContents += "       <RS n=\"" + refstrings[i].n + "\" a=\"" + refstrings[i].target + "\" df=\"" + refstrings[i].df + "\"" + CRLF + "       cDT=\"" + refstrings[i].cDT + "\" wC=\"" + refstrings[i].wC + "\"";
                        if (refstrings[i].mDT || refstrings[i].dDT) {
                            // optional datetime info
                            strContents += CRLF + "       ";
                            if (refstrings[i].mDT) {
                                strContents += " mDT=\"" + refstrings[i].mDT + "\"";
                            }
                            if (refstrings[i].dDT) {
                                strContents += " dDT=\"" + refstrings[i].dDT + "\"";
                            }
                        }
                        strContents += "/>" + CRLF;
                    }
                    strContents += "     </TU>" + CRLF;
                });
                // done strContents PART -- close out the file
                strContents += "     </MAP>" + CRLF + "</KB>" + CRLF;
                if (strContents === "") {
                    // didn't export anything
                    exportFail(new Error(i18n.t('view.dscErrNothingToExport')));
                    return false;
                } else {
                    // success
                    return true;
                }
            };

            // KB keyword export in SFM format (these use the \lx and \ge markers)
            // Note that this is SFM, not USFM. It's a pretty bare-bones export.
            var buildSFMKB = function () {
                var refstrings = null;
                var CRLF = "\r\n"; // windows line ending (carriage return + line feed)
                var i = 0;
                kblist.forEach(function (tu) { 
                    if (tu.get('source') === "**ImportedKBFile**") {
                        // skip this entry -- this is our internal "imported KB file" flag
                        return; // continue
                    }
                    // source line
                    strContents += "\\lx " + tu.get('source') + CRLF;
                    refstrings = tu.get('refstring');
                    // emit each TU as a \lx line item, and each refstring as a \ge line item
                    for (i = 0; i < refstrings.length; i++) {
                        strContents += "\\ge " + refstrings[i].target + CRLF;
                    }

                });
                // is there something in strContents?
                if (strContents === "") {
                    // didn't export anything
                    exportFail(new Error(i18n.t('view.dscErrNothingToExport')));
                    return false;
                } else {
                    // success
                    return true;
                }
            };

            // LIFT format (https://github.com/sillsdev/lift-standard)
            var buildLIFT = function () {
                var CRLF = "\r\n"; // windows line ending (carriage return + line feed)
                var XML_PROLOG = "<?xml version=\"1.0\"?>" + CRLF + "<lift version=\"0.15\">" + CRLF;
                var curDate = new Date();
                var timestamp = (curDate.getFullYear() + "-" + (curDate.getMonth() + 1) + "-" + curDate.getDay());
                var project = window.Application.currentProject;
                var i = 0;
                var refstrings = null;
                // opening strContents / LIFT file identification and version
                strContents = XML_PROLOG;
                kblist.forEach(function (tu) {
                    if (tu.get('source') === "**ImportedKBFile**") {
                        // skip this entry -- this is our internal "imported KB file" flag
                        return; // continue
                    }
                    // sort the refstrings on "n" (refcount)
                    refstrings = tu.get('refstring');
                    refstrings.sort(function (a, b) {
                        // high to low
                        return parseInt(b.n, 10) - parseInt(a.n, 10);
                    });
                    strContents += "<entry id=\"" + tu.get('source') + "\" dateModified=\"" + timestamp + "\">" + CRLF;
                    // source info -- single "lexical-unit" node
                    strContents += "  <lexical-unit>" + CRLF + "    <form lang=\"" + project.get('SourceLanguageCode') + "\"><text>"+ tu.get('source') +"</text></form>" + CRLF + "  </lexical-unit>" + CRLF;
                    for (i = 0; i < refstrings.length; i++) {
                        // refstring info -- 1+ "sense/gloss" node(s) under each entry
                        strContents += "  <sense id=\"" + window.Application.generateUUID() + "\">" + CRLF;
                        strContents += "    <gloss lang=\"" + project.get('TargetLanguageCode') + "\"><text>" + refstrings[i].target + "</text></gloss>" + CRLF;
                        strContents += "  </sense>" + CRLF;
                    }
                    strContents += "</entry>" + CRLF;
                });
                // done strContents PART -- close out the file
                strContents += "</lift>" + CRLF;
                // success
                return true;
            };

            var buildTMX = function () {
                var CRLF = "\r\n"; // windows line ending (carriage return + line feed)
                var XML_PROLOG = "<?xml version=\"1.0\" encoding=\"utf-8\" standalone=\"yes\"?>";
                var curDate = new Date();
                var timestamp = (curDate.getFullYear() + "-" + (curDate.getMonth() + 1) + "-" + curDate.getDay() + "T" + curDate.getUTCHours() + ":" + curDate.getUTCMinutes() + ":" + curDate.getUTCSeconds() + "z");
                var project = window.Application.currentProject;
                var i = 0;
                var refstrings = null;
                kblist.comparator = function (model) {
                    return model.get("mn");
                };
                kblist.sort();
                // opening strContents
                strContents = XML_PROLOG;
                // version and header
                strContents += "<tmx version=\"1.4\">" + CRLF + "<header creationtool=\"Adapt It Mobile\" creationtoolversion=\"" + window.Application.version + "\" datatype=\"plaintext\" segtype=\"sentence\" adminlang=\"en\" srclang=\"" + project.get('SourceLanguageCode') + "\" o-tmf=\"AI-XML\" creationdate=\"" + timestamp + "\">" + CRLF + "</header>" + CRLF;
                // body
                strContents += "<body>" + CRLF;
                kblist.forEach(function (tu) {
                    if (tu.get('source') === "**ImportedKBFile**") {
                        // skip this entry -- this is our internal "imported KB file" flag
                        return; // continue
                    }
                    // sort the refstrings on "n" (refcount)
                    refstrings = tu.get('refstring');
                    refstrings.sort(function (a, b) {
                        // high to low
                        return parseInt(b.n, 10) - parseInt(a.n, 10);
                    });
                    // emit each source/target refstring as a separate <tu> with a <tuv> for source, target
                    for (i = 0; i < refstrings.length; i++) {
                        strContents += "  <tu tuid=\"" + window.Application.generateUUID() + "\" datatype=\"Text\" usagecount=\"" + refstrings[i].n + "\">" + CRLF;
                        // source tuv
                        strContents += "    <tuv xml:lang=\"" + project.get('SourceLanguageCode') + "\">" + CRLF;
                        strContents += "      <seg>" + tu.get('source') + "</seg>" + CRLF + "    </tuv>" + CRLF;
                        // target tuv
                        strContents += "    <tuv xml:lang=\"" + project.get('TargetLanguageCode') + "\" creationdate=\"" + refstrings[i].cDT + "\" creationid=\"" + refstrings[i].wC + "\"";
                        if (refstrings[i].mDT) {
                            // optional datetime info
                            if (refstrings[i].mDT) {
                                strContents += " changedate=\"" + refstrings[i].mDT + "\"";
                            }
                        }
                        strContents += ">" + CRLF;
                        strContents += "      <seg>" + refstrings[i].target + "</seg>" + CRLF + "    </tuv>" + CRLF + "  </tu>" + CRLF;
                    }
                });
                // done strContents PART -- close out the file
                strContents += "     </body>" + CRLF + "</tmx>" + CRLF;
                // success
                return true;
            };
            //// *** END export functions
            

            strContents = ""; // clear out any old cruft
            if (device && (device.platform !== "browser")) {
                // generate the document in the specified format
                switch (format) {
                    case FileTypeEnum.TXT:
                        bResult = buildText();
                        break;
                    case FileTypeEnum.USFM:
                        // User could be exporting the translation, gloss, or free translation
                        if (content === contentEnum.GLOSS) {
                            bResult = buildUSFMGloss();
                        } else if (content === contentEnum.FT) {
                            bResult = buildUSFMFT();
                        } else { // (content === contentEnum.ADAPTATION)
                            bResult = buildUSFM();
                        }
                        break;
                    case FileTypeEnum.USX:
                        bResult = buildUSX();
                        sType = "text/xml"; // XML under the hood
                        break;
                    case FileTypeEnum.XML:
                        bResult = buildAIDocXML();
                        sType = "text/xml";
                        break;
                    case FileTypeEnum.KBXML:
                        bResult = buildKBXML();
                        sType = "text/xml";
                        break;
                    case FileTypeEnum.KBTMX:
                        bResult = buildTMX();
                        sType = "text/xml"; // xml under the hood
                        break;
                    case FileTypeEnum.GLOSSKBXML:
                        bResult = buildGlossKB();
                        sType = "text/xml";
                        break;
                    case FileTypeEnum.SFM_KB:
                        bResult = buildSFMKB();
                        break;
                    case FileTypeEnum.LIFT:
                        bResult = buildLIFT();
                        sType = "text/xml"; // XML under the hood
                        break;
                }
                if (bResult === false) {
                    // Problem creating the file to export, but we've already called exportFail --
                    // just clear our static strContents and return
                    strContents = "";
                    return;
                }
                // strContents now has the selected book in the selected format. Export it to the proper location
                if (isClipboard === true) {
                    // to Clipboard
                    cordova.plugins.clipboard.copy(strContents);
                    // directly call success (it's a callback for the file writer)
                    exportSuccess();
                } else {
                    // To FILE -- Create a Blob from strContents and ask the user
                    // to pick a destination (and optionally change the filename), then do the export
                    let blob = new Blob([strContents], {type: sType});
                    cordova.plugins.saveDialog.saveFile(blob, filename).then(uri => {
                        console.info("The file has been successfully saved to", uri);
                        exportSuccess();
                    }).catch(reason => {
                        exportFail(reason);
                    });    
                }
                strContents = ""; // clear out the content string
            } else {
                // browser works a little differently --
                // Here we don't use the saveDialog plugin, but rather request the persistent storage.
                var requestedBytes = 10 * 1024 * 1024; // 10MB
                window.requestFileSystem = window.requestFileSystem || window.webkitRequestFileSystem;
                navigator.webkitPersistentStorage.requestQuota(requestedBytes, function (grantedBytes) {
                    window.requestFileSystem(window.PERSISTENT, grantedBytes, function (fs) {
                        fs.root.getFile(filename, {create: true}, function (fileEntry) {
                            fileEntry.createWriter(function (fileWriter) {
                                writer = fileWriter;
                                writer.onwriteend = function() {
                                    console.log("write completed.");
                                    if (chaptersLeft === 0) {
                                        exportSuccess();
                                    }
                                };                        
                                writer.onerror = function (e) {
                                    console.log("write failed: " + e.toString());
                                    exportFail(e);
                                };
                                console.log("Got fileWriter");
                                // generate the document in the specified format
                                switch (format) {
                                case FileTypeEnum.TXT:
                                    bResult = buildText();
                                    break;
                                case FileTypeEnum.USFM:
                                    // User could be exporting the translation, gloss, or free translation
                                    if (content === contentEnum.GLOSS) {
                                        bResult = buildUSFMGloss();
                                    } else if (content === contentEnum.FT) {
                                        bResult = buildUSFMFT();
                                    } else { // (content === contentEnum.ADAPTATION)
                                        bResult = buildUSFM();
                                    }
                                    break;
                                case FileTypeEnum.USX:
                                    bResult = buildUSX();
                                    sType = "text/xml";
                                    break;
                                case FileTypeEnum.XML:
                                    bResult = buildAIDocXML();
                                    sType = "text/xml";
                                    break;
                                case FileTypeEnum.KBXML:
                                    bResult = buildKBXML();
                                    sType = "text/xml";
                                    break;
                                case FileTypeEnum.KBTMX:
                                    bResult = buildTMX();
                                    sType = "text/xml";
                                    break;
                                case FileTypeEnum.SFM_KB:
                                    bResult = buildSFMKB();
                                    break;
                                case FileTypeEnum.LIFT:
                                    bResult = buildLIFT();
                                    sType = "text/xml";
                                    break;
                                }
                                if (bResult === false) {
                                    // Problem creating the file to export, but we've already called exportFail --
                                    // just clear our static strContents and return
                                    strContents = "";
                                    return;
                                }
                                // strContents now has the selected book in the selected format. Export it to the proper location
                                if (isClipboard === true) {
                                    // browser -- use clipboard API
                                    navigator.clipboard.writeText(strContents).then(exportSuccess, exportFail);
                                } else {
                                    // to file -- create a blob for the fileWriter
                                    // (exportSuccess and exportFail are called from the onwriteend/onwritefail calls above)
                                    var blob = new Blob([strContents], {type: sType});
                                    writer.write(blob);
                                }
                                strContents = ""; // clear out the content string
                            }, exportFail);
                        }, exportFail);
                    }, exportFail);
                }, exportFail);
            }
        },
        
        // ****************************************
        // END static methods
        // ****************************************
        
        // ImportDocumentView
        // Select and import documents (txt, usfm, sfm, usx, xml) into 
        // AIM from the device or PC, depending on where AIM is run from. 
        ImportDocumentView = Marionette.ItemView.extend({
            template: Handlebars.compile(tplImportDoc),
            isLoadingFromURL: false,
            
            initialize: function () {
                this.bookList = new bookModel.BookCollection();
            },
            
            ////
            // Event Handlers
            ////
            events: {
                "change #selFile": "browserImportDocs",
                "click #btnBrowse": "onBtnBrowse",
                "click #btnClipboard": "onBtnClipboard",
                "click #btnCancel": "onCancel",
                "click #OK": "onOK"
            },
            // Handler for when another process sends us a file to import. The logic is in
            // window.handleOpenURL (main.js) and Application::importFileFromURL() (Application.js).
            importFromURL: function (file) {
                // if this is a content URL from Android, the name is all messed up (it shows "content") -
                // pull out the real filename that we stored on the Application object earlier
                // (in either main.js at startup, or when we went to the home screen in Application.js)
                if (window.Application.importingURL.length > 0) {
                    fileName = window.Application.importingURL.substr(window.Application.importingURL.lastIndexOf('/') + 1);
                    window.Application.importingURL = "";
                } else {
                    fileName = file.name;
                }
                console.log("importfromURL: importing file: " + fileName);
                // replace the selection UI with the import UI
                $("#selectControls").hide();
                $("#LoadingStatus").html(Handlebars.compile(tplLoadingPleaseWait));
                // Import can take a while, and potentially hang. Provide a way to cancel the operation
                $("#btnCancel").show();                
                $("#status").html(i18n.t("view.dscStatusReading", {document: fileName}));
                $("#btnOK").hide();
                // import the specified file
                importFile(file, this.model);
            },
            // Handler for when the user clicks the Select button (browser only) -
            // (this is the html <input type=file> element  displayed for the browser only) --
            // file selections are returned by the browser in the event.currentTarget.files array
            browserImportDocs: function (event) {
                var fileindex = 0;
                var files = event.currentTarget.files;
                fileCount = files.length;
                if (fileCount > 0) {
                    isClipboard = false;
                    // replace the selection UI with the import UI
                    $("#selectControls").hide();
                    $("#LoadingStatus").html(Handlebars.compile(tplLoadingPleaseWait));
                    // Import can take a while, and potentially hang. Provide a way to cancel the operation
                    $("#btnCancel").show();   
                    // each of the files items is a file object already; call importFile() directly.
                    while (fileindex < fileCount) {
                        fileName = files[fileindex].name;
                        importFile(files[fileindex], this.model);
                        fileindex++;
                    }
                }
            },
            // User clicked on the (mobile) Select file button --
            // call getFile() on the chooser plugin, and if we get a file back, import it
            onBtnBrowse: function () {
                var model = this.model;
                chooser.getFile('*/*', function (file) {
                    console.log(file ? file.name : 'canceled');
                    if (file) {
                        isClipboard = false;
                        // replace the selection UI with the import UI
                        $("#selectControls").hide();
                        $("#LoadingStatus").html(Handlebars.compile(tplLoadingPleaseWait));
                        // Import can take a while, and potentially hang. Provide a way to cancel the operation
                        $("#btnCancel").show();   
                        fileName = file.name;
                        window.resolveLocalFileSystemURL(file.uri,
                            function (entry) {
                                entry.file(
                                    function (oFile) {
                                        $("#status").html(i18n.t("view.dscStatusReading", {document: fileName}));
                                        importFile(oFile, model);
                                    },
                                    function (error) {
                                        console.log("FileEntry.file error: " + error.code);
                                    }
                                );
                            },
                            function (error) {
                                console.log("resolveLocalFileSystemURL error: " + error.code);
                            });
                    }
                }, function (error) {
                    // Log the error
                    console.log("CopyProjectView::onBtnBrowse getFile() error: " + error);
                });
            },
            // Handler for when the user clicks the "clipboard text" option;
            // copy the clipboard contents, and if they're not empty, try to import the contents as a file
            onBtnClipboard: function () {
                var model = this.model;
                // Are we in the browser or on a mobile device?
                if (device && (device.platform !== "browser")) {
                    // mobile device
                    cordova.plugins.clipboard.paste(function (text) {
                        if (text !== null && text.length > 0) {
                            // paste call returned AND there's something on the clipboard
                            console.log("Clipboard contents: " + text);
                            isClipboard = true;
                            // replace the selection UI with the import UI
                            $("#selectControls").hide();
                            $("#LoadingStatus").html(Handlebars.compile(tplLoadingPleaseWait));
                            // Import can take a while, and potentially hang. Provide a way to cancel the operation
                            $("#btnCancel").show();   
                            // EDB 12/19/2023: ? not sure if still true - ios has wkwebview now? need to test
                            // EDB 5/29 HACK: clipboard text -- create a blob instead of a file and read it:
                            // Cordova-ios uses an older web view that has a buggy / outdated JS engine w.r.t the File object;
                            // it places the contents in the name attribute. The FileReader does
                            // accept a Blob (the File object derives from Blob), which is why importFile works.
                            console.log("Clipboard selected. Creating ad hoc file from text.");
                            var clipboardFile = new Blob([text], {type: "text/plain"});
                            $("#status").html(i18n.t("view.dscStatusReading", {document: i18n.t("view.lblCopyClipboardText")}));
                            fileName = i18n.t("view.lblText") + "-" + (window.Application.generateUUID());
                            importFile(clipboardFile, model);    
                        } else {
                            console.log("No data to import");
                            // No data to import -- tell the user to copy something to the clipboard
                            if (navigator.notification) { // just in case...
                                // on mobile device -- use notification plugin API
                                navigator.notification.alert(i18n.t('view.ErrNoClipboard'));
                            } else {
                                // fall back on webview alert
                                alert(i18n.t('view.ErrNoClipboard'));
                            }
                        }
                    }, function (error) {
                        // error in clipboard retrieval -- skip entry
                        // (seen this when there's data on the clipboard that isn't text/plain)
                        console.log("Error retrieving clipboard data:" + error);
                    });
                } else {
                    // browser
                    navigator.clipboard.readText().then(
                    (clipText) => {
                        if (clipText.length > 0) {
                            var clipboardFile = new Blob([clipText], {type: "text/plain"});
                            isClipboard = true;
                            console.log("Non-empty clipboard selected. Creating ad hoc file from text.");
                            // replace the selection UI with the import UI
                            $("#selectControls").hide();
                            $("#LoadingStatus").html(Handlebars.compile(tplLoadingPleaseWait));
                            // Import can take a while, and potentially hang. Provide a way to cancel the operation
                            $("#btnCancel").show();   
                            $("#status").html(i18n.t("view.dscStatusReading", {document: i18n.t("view.lblCopyClipboardText")}));
                            fileName = i18n.t("view.lblText") + "-" + (window.Application.generateUUID());
                            importFile(clipboardFile, model);            
                        } else {
                            console.log("No data to import");
                            // No data to import -- tell the user to copy something to the clipboard
                            // in browser -- use window.confirm / window.alert
                            alert(i18n.t('view.ErrNoClipboard'));
                        }
                    });
                }
            },
            // Handler for the Cancel button (in the loading / please wait template) --
            // user is cancelling the import (might be hung?)
            onCancel: function () {
                // User is cancelling the import operation -- roll back and go home
                var deletedCurrentDoc = false;
                var lastAdaptedBookID = "";
                if (isKB === false && window.Application.currentBookmark !== null) {
                    // can only really roll back a book import (by deleting it)
                    lastAdaptedBookID = window.Application.currentBookmark.get('bookid');
                    var book = window.Application.BookList.where({projectid: this.model.get('projectid'), filename: fileName})[0];
                    if (book) {
                        // got as far as saving the book -- did we happen to set this to the current book?
                        var key = book.get("bookid");
                        console.log("deleting bookID: " + key);
                        // are we deleting something we were just working on?
                        if (lastAdaptedBookID === key) {
                            // yup -- flag this condition, so we can deal with it below
                            deletedCurrentDoc = true;
                        }
                        // First, remove the book from the collection
                        window.Application.BookList.remove(book);
                        // ...and destroy the book and contents (SQL includes chapters and sourcephrases)
                        book.destroy();
                        // Now do any extra processing to reset the last document, etc...
                        // Did we just delete all the books?
                        if (window.Application.BookList.length === 0) {
                            // no more books -- also remove the bookmark
                            window.Application.bookmarkList.remove(window.Application.currentBookmark);                
                            window.Application.currentBookmark = null;
                        } else if (deletedCurrentDoc === true) {
                            // We just deleted the current Document/book
                            window.Application.bookmarkList.remove(window.Application.currentBookmark);                
                            window.Application.currentBookmark = null;
                            // create a bookmark pointing to the first chapter of the first book in our book list
                            var bk = window.Application.BookList.at(0);
                            if (bk) {
                                // got it -- set the lastAdapted stuff to the first chapter
                                var cid = bk.get("chapters")[0];
                                var bookmarkid = window.Application.generateUUID();
                                var newBookmark = new userModels.Bookmark({
                                    bookmarkid: bookmarkid,
                                    projectid: bk.get('projectid'),
                                    name: bk.get("name"), // BUGBUG - should be chaptername within book?
                                    bookid: bk.get("bookid"),
                                    chapterid: cid
                                });
                                // save and add to the collection
                                newBookmark.save();
                                window.Application.bookmarkList.add(newBookmark);
                                // this is the current project -- set this bookmark as the current bookmark
                                window.Application.currentBookmark = newBookmark;
                            }
                            window.Application.currentProject.save();
                        }
                    }
                }
                // Okay, done deleting / rolling back the import -- now head back to the home page
                if (window.history.length > 1) {
                    // there actually is a history -- go back
                    window.history.back();
                } else {
                    // no history (import link from outside app) -- just go home
                    window.location.replace("");
                }
            },

            // Handler for the OK button:
            // - If the user has changed the book name, update the name value in the book and each chapter
            // - Close out the import and move to the home page
            onOK: function () {
                console.log("onOK - entry");
                if (bookName.length === 0) {
                    // prevent re-entry -- just go to the home page
                    if (window.history.length > 1) {
                        // there actually is a history -- go back
                        window.history.back();
                    } else {
                        // no history (import link from outside app) -- just go home
                        window.location.replace("");
                    }
                    return;
                }
                if (isKB === false) {
                    // update the book name if necessary
                    if ($("#BookName").length > 0 && $("#BookName").val() !== bookName) {
                        // name change -- update all the things
                        var newName = $("#BookName").val().trim();
                        console.log("onOK() - new book name: " + newName);
                        var book = window.Application.BookList.where({projectid: this.model.get('projectid'), name: bookName})[0];
                        var i = 0;
                        var chapterName = "";
                        var newChapterName = "";
                        var firstChapWithVerses = null;
                        var chap = null;
                        // book name
                        if (book) {
                            book.set('name', newName, {silent: true});
                            book.update();
                        }
                        // chapter names in the chapter list
                        var chapterList = window.Application.ChapterList.where({bookid: book.get('bookid')});
                        for (i = 0; i < chapterList.length; i++) {
                            chap = chapterList[i];
                            chapterName = chap.get('name');
                            newChapterName = chapterName.replace(bookName, newName);
                            chap.save({name: newChapterName});
                            if (firstChapWithVerses === null && chap.get('versecount') !== 0) {
                                firstChapWithVerses = chap;
                                // it's possible we also need to change the name in our bookmark
                                if (window.Application.currentBookmark.get("name").indexOf(bookName) > -1) {
                                    // we have chapters -- use the first one that has some verses
                                    window.Application.currentBookmark.set('name', chap.get('name'));
                                }
                            }
                        }
                        // name in the current bookmark
                        window.Application.currentBookmark.set("name", chapterList[0].get('name'), {silent: true});
                        window.Application.currentBookmark.update();
                    }
                    // save the model
                    this.model.save();
                    window.Application.currentProject = this.model;
                    bookName = ""; // clear out book name data
                }
                
                // head back to the home page
                if (window.history.length > 1) {
                    // there actually is a history -- go back
                    window.history.back();
                } else {
                    // no history (import link from outside app) -- just go home
                    window.location.replace("");
                }
            },
            // Show event handler (from MarionetteJS)
            onShow: function () {
                var punctExp = "";
                $("#title").html(i18n.t('view.lblImportDocuments'));
                $("#OKCancelButtons").hide();
                $("#verifyNameControls").hide();
                // build the regular expression to identify punctuation
                // (this allows us to split out punctuation as separate tokens when importing
                punctExp = "[\\s";
                this.model.get('PunctPairs').forEach(function (elt, idx, array) {
                    // Unicode-encoded punctuation, formatted to get leading 00 padding (e.g., \U0065 for "a"),
                    // each punctuation marker is bound in "capturing parentheses", meaning that
                    // the punctuation itself is kept as a separate token in the array when we perform our split() call.
                    // Note that we have to do a charCodeAt(), which returns the decimal value of the unicode char,
                    // then convert it to hex using toString(16).
                    puncts.push(elt.s);
                    punctExp += "(\\u" + ("000" + elt.s.charCodeAt(0).toString(16)).slice(-4) + ")";
                });
                punctExp += "]+"; // one or more of ANY of the above will trigger a new token

                // load the source / target punctuation pairs
                this.model.get('PunctPairs').forEach(function (elt, idx, array) {
                    punctsSource.push(elt.s);
                    punctsTarget.push(elt.t);
                });
                // load the source / target case pairs
                this.model.get('CasePairs').forEach(function (elt, idx, array) {
                    caseSource.push(elt.s);
                    caseTarget.push(elt.t);
                });
                // fetch the KB in case we import an AI XML document (we'll populate the KB if that happens)
                window.Application.kbList.clearLocal(); // clear out the kbList so it gets rebuilt
                kblist = window.Application.kbList;
                kblist.fetch({reset: true, data: {projectid: window.Application.currentProject.get("projectid")}});
                // reset the file type flags
                isKB = false;
                isGlossKB = false;
                isProjectFile = false;
                // show either the browser or mobile selection buttons
                if (this.isLoadingFromURL === false) {
                    if (device && (device.platform !== "browser")) {
                        // running on device -- use choooser plugin to select file
                        $("#browserSelect").hide();
                    } else {
                        // running in browser -- use html <input> to select file
                        $("#mobileSelect").hide();
                    }       
                }
            }
        }),
        
        ExportDocumentView = Marionette.ItemView.extend({
            destination: DestinationEnum.FILE,
            content: contentEnum.ADAPTATION,
            template: Handlebars.compile(tplExportDoc),

            initialize: function () {
                document.addEventListener("resume", this.onResume, false);
                this.bookList = new bookModel.BookCollection();
            },
            
            ////
            // Event Handlers
            ////
            events: {
                "click .docListItem": "selectDoc",
                "click #toClipboard": "onToClipboard",
                "click #toFile": "onToFile",
                "click #exportAdaptation": "onExportAdaptation",
                "click #exportGloss": "onExportGloss",
                "click #exportFT": "onExportFT",
                "click #OK": "onOK",
                "click #btnOK": "onBtnOK",
                "click #btnCancel": "onBtnCancel",
                "click #Cancel": "onCancel"
            },
            // Resume handler -- user placed the app in the background, then resumed.
            onResume: function () {
                // reload the Export wizard, UNLESS we got bumped out by the doc Save process
                if (bOperationDone === false) {
                    Backbone.history.loadUrl(Backbone.history.fragment);
                }
            },
            // User wants to export the adaptation / target text. For Adapt It (.xml) format, this includes the gloss and FT data.
            onExportAdaptation: function () {
                console.log("User is exporting adaptation text");
                // show the next screen
                this.content = contentEnum.ADAPTATION;
                $("#lblExportDirections").html(i18n.t('view.lblExportSummary', {content: i18n.t('view.lblExportAdaptation'), document: bookName}));
                $("#Container").html(Handlebars.compile(tplExportFormat));
                // Show the file format stuff
                $("#FileFormats").show();
                $("#KBFormats").hide();
                $("#glossKBFormat").hide();
                // if this is going to the clipboard, we don't need a filename
                if (this.destination === DestinationEnum.CLIPBOARD) {
                    $("#grpFilename").hide();
                }
                // select a default of TXT for the export format (for now)
                $("#buildTXT").prop("checked", true);
            },
            // User wants to export the glosses. This exports to USFM.
            onExportGloss: function () {
                console.log("User is exporting gloss text");
                // show the next screen
                this.content = contentEnum.GLOSS;
                $("#lblExportDirections").html(i18n.t('view.lblExportSummary', {content: i18n.t('view.lblExportGloss'), document: bookName}));
                $("#Container").html(Handlebars.compile(tplExportFormat));
                $("#KBFormats").hide();
                $("#glossKBFormat").hide();
                $("#FileFormats").hide();
                // if this is going to the clipboard, we don't need a filename
                if (this.destination === DestinationEnum.CLIPBOARD) {
                    $("#grpFilename").hide();
                }
                // SFM for the export format
                $("#ttlFormat").html(i18n.t('view.lblExportSelectFormat') + " " + i18n.t('view.lblbuildUSFM'));
            },
            // User wants to export the free translation data. This exports to USFM.
            onExportFT: function () {
                console.log("User is exporting FT text");
                // show the next screen
                this.content = contentEnum.FT;
                $("#lblExportDirections").html(i18n.t('view.lblExportSummary', {content: i18n.t('view.lblExportFT'), document: bookName}));
                $("#Container").html(Handlebars.compile(tplExportFormat));
                $("#KBFormats").hide();
                $("#glossKBFormat").hide();
                $("#FileFormats").hide();
                // if this is going to the clipboard, we don't need a filename
                if (this.destination === DestinationEnum.CLIPBOARD) {
                    $("#grpFilename").hide();
                }
                // SFM for the export format
                $("#ttlFormat").html(i18n.t('view.lblExportSelectFormat') + " " + i18n.t('view.lblbuildUSFM'));
            },
            // User selected export to a file
            onToFile: function () {
                var list = "";
                var pid = this.model.get('projectid');
                console.log("File selected");
                // set the destination to File
                this.destination = DestinationEnum.FILE;
                // build and display the book selection list
                $.when(window.Application.BookList.fetch({reset: true, data: {name: ""}}).done(function () {
                    list = buildDocumentList(pid);
                    $("#Container").html("<ul class='topcoat-list__container chapter-list'>" + list + "</ul>");
                    $('#lblExportDirections').html(i18n.t('view.lblExportSelectDocument'));
                    $('#lblExportDirections').show();
                }));
            },
            // User selected the clipboard 
            onToClipboard: function () {
                var list = "";
                var pid = this.model.get('projectid');
                console.log("Clipboard selected");
                this.destination = DestinationEnum.CLIPBOARD;
                // build and display the book selection list
                $.when(window.Application.BookList.fetch({reset: true, data: {name: ""}}).done(function () {
                    list = buildDocumentList(pid);
                    $("#Container").html("<ul class='topcoat-list__container chapter-list'>" + list + "</ul>");
                    $('#lblExportDirections').html(i18n.t('view.lblExportSelectDocument'));
                    $('#lblExportDirections').show();
                }));
            },
            // User clicked the OK button. Export the selected document to the specified format.
            onOK: function () {
                var filename = bookName;
                var project = window.Application.currentProject;
                if ($("#buildAIDocXML").length === 0) {
                    // if this is the export complete page,
                    // go back to the previous page
                    bOperationDone = false;
                    window.history.go(-1);
                } else {
                    var format = FileTypeEnum.TXT;
                    // build the suggested filename based on the file type
                    if ($("#buildAIDocXML").is(":checked")) {
                        filename += ".xml";
                    } else if ($("#buildUSX").is(":checked")) {
                        filename += ".usx";
                    } else if ($("#buildUSFM").is(":checked")) {
                        filename += ".sfm";
                    } else if ($("#buildKBXMLTMX").is(":checked")) {
                        filename += ".tmx";
                    } else if ($("#buildKBXMLSFM").is(":checked")) {
                        filename += ".sfm";
                    } else if ($("#buildKBXMLLIFT").is(":checked")) {
                        filename += ".lift";
                    } else if ($("#buildGlossKBXML").is(":checked")) {
                        // overwrite to hard-coded string (do not localize)
                        filename = "Glossing.xml";
                    } else if ($("#buildKBXMLXML").is(":checked")) {
                        // overwrite to hard-coded string (do not localize)
                        filename = project.get('SourceLanguageName') + " to " + project.get('TargetLanguageName') + " adaptations.xml";
                    } else {
                        // fallback to plain text
                        filename += ".txt";
                    }

                    // validate input
                    if ((filename.length === 0) && (this.destination !== DestinationEnum.CLIPBOARD)) {
                        // user didn't type anything in
                        // just tell them to enter something
                        if (navigator.notification) {
                            // on mobile device -- use notification plugin API
                            navigator.notification.alert(i18n.t('view.errNoFilename'));
                        } else {
                            // in browser -- use window.confirm / window.alert
                            alert(i18n.t('view.errNoFilename'));
                        }
                    } else {
                        // get the desired format
                        if ($("#buildAIDocXML").is(":checked")) {
                            format = FileTypeEnum.XML;
                        } else if ($("#buildUSX").is(":checked")) {
                            format = FileTypeEnum.USX;
                        } else if ($("#buildUSFM").is(":checked")) {
                            format = FileTypeEnum.USFM;
                        } else if ($("#buildKBXMLXML").is(":checked")) {
                            format = FileTypeEnum.KBXML;
                        } else if ($("#buildKBXMLTMX").is(":checked")) {
                            format = FileTypeEnum.KBTMX;
                        } else if ($("#buildKBXMLSFM").is(":checked")) {
                            format = FileTypeEnum.SFM_KB;
                        } else if ($("#buildKBXMLLIFT").is(":checked")) {
                            format = FileTypeEnum.LIFT;
                        } else if ($("#buildGlossKBXML").is(":checked")) {
                            format = FileTypeEnum.GLOSSKBXML;
                        } else {
                            if (this.content !== contentEnum.ADAPTATION) {
                                // User is exporting gloss or FT data -- use USFM format
                                format = FileTypeEnum.USFM;
                            } else {
                                // fallback to plain text
                                format = FileTypeEnum.TXT;
                            }
                        }
                        // update the UI
                        $("#mobileSelect").html(Handlebars.compile(tplLoadingPleaseWait));
                        $("#loading").html(i18n.t("view.lblExportingPleaseWait"));
                        $("#status").html(i18n.t("view.dscExporting", {file: filename}));
                        $("#OK").hide();
                        $("#btnCancel").show();                
                        // perform the export
                        if (this.destination === DestinationEnum.CLIPBOARD) {
                            isClipboard = true;
                        }
                        exportDocument(bookid, format, filename, this.content);
                    }
                }
            },
            // User clicked the Cancel button DURING EXPORT. This is probably due to a hung export process
            onBtnCancel: function () {
                // TODO: roll back any changes?
                bOperationDone = false;
                // go back to the previous page
                if (window.history.length > 1) {
                    // there actually is a history -- go back
                    window.history.back();
                } else {
                    // no history -- just go home
                    window.location.replace("");
                }
            },
            // User clicked the Cancel button. Here we don't do anything -- just return
            onCancel: function () {
                bOperationDone = false;
                // go back to the previous page
                if (window.history.length > 1) {
                    // there actually is a history -- go back
                    window.history.back();
                } else {
                    // no history -- just go home
                    window.location.replace("");
                }
            },
            // User clicked the OK button AFTER EXPORT success/fail. Here we don't do anything -- just return
            onBtnOK: function () {
                bOperationDone = false;
                // go back to the previous page
                if (window.history.length > 1) {
                    // there actually is a history -- go back
                    window.history.back();
                } else {
                    // no history -- just go home
                    window.location.replace("");
                }
            },
            
            selectDoc: function (event) {
                var project = window.Application.currentProject;
                // get the info for this document
                bookName = event.currentTarget.innerText;
                bookid = $(event.currentTarget).attr('id').trim();
                // show the next screen
                $("#lblExportDirections").html(i18n.t('view.lblDocSelected') + bookName);
                $("#Container").html(Handlebars.compile(tplExportFormat));
                if (bookid === "kb") {
                    console.log("User exporting KB");
                    // exporting the KB
                    $("#FileFormats").hide();
                    $("#KBFormats").show();
                    $("#glossKBFormat").hide();
                    // select a default of XML for the export format (for now)
                    $("#buildKBXMLXML").prop("checked", true);
                } else if (bookid === "glosskb") {
                    console.log("User exporting GLOSS KB");
                    // exporting the gloss KB (really only one option here -- "Glossing.xml")
                    $("#FileFormats").hide();
                    $("#KBFormats").hide();
                    $("#glossKBFormat").show();
                    $("#buildGlossKBXML").prop("checked", true);
                } else {
                    console.log("User exporting a document");
                    // exporting a book
                    // load the chapters if needed 
                    window.Application.ChapterList.fetch({reset: true, data: {bookid: bookid}});
                    // Is the "show gloss and FT" check selected?
                    if (localStorage.getItem("ShowGlossFT") && localStorage.getItem("ShowGlossFT") === "true") {
                        console.log("User has gloss/FT enabled -- need to ask what they want to export");
                        // "show gloss and FT" is selected -- user might want to export the gloaa or FT instead of the document
                        // Now show the Export Content page to find out what they want to export from this document
                        // show the next screen
                        $("#lblExportDirections").html(i18n.t('view.lblSelectContent'));
                        $("#Container").html(Handlebars.compile(tplExportContent));
                        // remove any file extension found on the book name
                        if (bookName.length > 0) {
                            if ((bookName.indexOf(".xml") > -1) || (bookName.indexOf(".txt") > -1) || (bookName.indexOf(".sfm") > -1) || (bookName.indexOf(".usx") > -1)) {
                                bookName = bookName.substr(0, bookName.length - 4);
                            }
                        }
                    } else {
                        console.log("User is just exporting the adaptation data");
                        $("#FileFormats").show();
                        $("#KBFormats").hide();
                        $("#glossKBFormat").hide();
                        // if this is going to the clipboard, we don't need a filename
                        if (this.destination === DestinationEnum.CLIPBOARD) {
                            $("#grpFilename").hide();
                        }
                        // remove any file extension on the book name
                        if (bookName.length > 0) {
                            if ((bookName.indexOf(".xml") > -1) || (bookName.indexOf(".txt") > -1) || (bookName.indexOf(".sfm") > -1) || (bookName.indexOf(".usx") > -1)) {
                                bookName = bookName.substr(0, bookName.length - 4);
                            }
                        }
                        // select a default of TXT for the export format (for now)
                        $("#buildTXT").prop("checked", true);
                        bookName += ".txt";
                    }
                }
            },
            onShow: function () {
                bOperationDone = false; // reset the operation done flag
                kblist = window.Application.kbList;
                $.when(kblist.fetch({reset: true, data: {projectid: window.Application.currentProject.get("projectid")}})).done(function() {
                    // first step -- clipboard or file?
                    $("#Container").html(Handlebars.compile(tplExportDestination));
                    $('#lblExportDirections').hide();
                });
            }
        });
    
    return {
        ImportDocumentView: ImportDocumentView,
        ExportDocumentView: ExportDocumentView
    };

});
