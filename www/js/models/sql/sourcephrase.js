/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50 */
/*global define */

/* 
* SourcePhrase.js
*/
define(function (require) {

    "use strict";

    var $           = require('jquery'),
        Backbone    = require('backbone'),
        Underscore  = require('underscore'),
        sourcephrases = [],
        
        // ***
        // STATIC METHODS
        // ***

        findById = function (searchKey) {
            var deferred = $.Deferred();
            var results = sourcephrases.filter(function (element) {
                return element.attributes.spid.toLowerCase().indexOf(searchKey.toLowerCase()) > -1;
            });
            deferred.resolve(results);
            return deferred.promise();
        },

        SourcePhrase = Backbone.Model.extend({
            // default values
            defaults: {
                spid: "",
                chapterid: "",
                vid: "", // 1.6 (verse ID for multiple imports) - can refer to range of verses (e.g., \v 1-6)
                norder: 0,
                markers: "",
                orig: null,
                prepuncts: "",
                midpuncts: "",
                follpuncts: "",
                flags: "0000000000000000000000", // 22
                texttype: 0,
                gloss: "",
                freetrans: "",
                note: "",
                srcwordbreak: "",
                tgtwordbreak: "",
                source: "", // source includes punctuation as of 1.2 (was inconsistent before)
                target: ""
            },

            initialize: function () {
                this.on('change', this.save, this);
            },
            fetch: function () {
                var attributes = this.attributes;
                window.Application.db.transaction(function (tx) {
                    tx.executeSql("SELECT * FROM sourcephrase WHERE spid=?;", [attributes.spid], function (tx, res) {
                        this.set(res.rows.item(0));
                    });
                });
                
            },
            create: function () {
                var deferred = $.Deferred();
                var attributes = this.attributes;
                var sql = "INSERT INTO sourcephrase (spid, norder, chapterid, vid, markers, orig, prepuncts, midpuncts, follpuncts, flags, texttype, gloss, freetrans, note, srcwordbreak, tgtwordbreak, source, target) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);";
                window.Application.db.transaction(function (tx) {
                    tx.executeSql(sql, [attributes.spid, attributes.norder, attributes.chapterid, attributes.vid, attributes.markers, attributes.orig, attributes.prepuncts, attributes.midpuncts, attributes.follpuncts, attributes.flags, attributes.texttype, attributes.gloss, attributes.freetrans, attributes.note, attributes.srcwordbreak, attributes.tgtwordbreak, attributes.source, attributes.target], function (tx, res) {
                        attributes.id = res.insertId;
                        console.log("sourcephrase INSERT ok.");
                        deferred.resolve();
                    }, function (tx, err) {
                        console.log("sourcephrase INSERT error: " + err.message);
                        deferred.reject(err);
                    });
                }, function (e) {
                    console.log("sourcephrase create: transation error:" + e.message);
                    deferred.reject(e);
                }, function () {
                    console.log("sourcephrase create: transaction OK.");
                });
                return deferred.promise();

            },
            update: function () {
                var deferred = $.Deferred();
                var attributes = this.attributes;
                var sql = 'UPDATE sourcephrase SET norder=?, chapterid=?, vid=?, markers=?, orig=?, prepuncts=?, midpuncts=?, follpuncts=?, flags=?, texttype=?, gloss=?, freetrans=?, note=?, srcwordbreak=?, tgtwordbreak=?, source=?, target=? WHERE spid=?;';
                window.Application.db.transaction(function (tx) {
                    tx.executeSql(sql, [attributes.norder, attributes.chapterid, attributes.vid, attributes.markers, attributes.orig, attributes.prepuncts, attributes.midpuncts, attributes.follpuncts, attributes.flags, attributes.texttype, attributes.gloss, attributes.freetrans, attributes.note, attributes.srcwordbreak, attributes.tgtwordbreak, attributes.source, attributes.target, attributes.spid], function (tx, res) {
                        console.log("sourcephrase UPDATE ok.");
                    }, function (tx, err) {
                        console.log("sourcephrase UPDATE error: " + err.message);
                    });
                }, function (e) {
                    deferred.reject(e);
                }, function () {
                    deferred.resolve();
                });
                return deferred.promise();
            },
            destroy: function (options) {
                var attributes = this.attributes;
                window.Application.db.transaction(function (tx) {
                    tx.executeSql("DELETE FROM sourcephrase WHERE spid=?;", [attributes.spid], function (tx, res) {
//                        console.log("DELETE ok: " + res.toString());
                    }, function (tx, err) {
                        console.log("DELETE error: " + err.message);
                    });
                });
            },
            sync: function (method, model, options) {
                if (typeof options === 'function') {
                    options = {
                        success: options,
                        error: error
                    };
                }
                switch (method) {
                case 'create':
                    // model.create();
                    $.when(model.create())
                      .done(function() {
                        options.success(model);
                      })
                      .fail(function() {
                        options.error;
                      });
                    break;
                        
                case 'read':
                    findById(this.id).done(function (data) {
                        options.success(data);
                    });
                    break;
                        
                case 'update':
                    model.update();
                    // options.success(model);
                    break;
                        
                case 'delete':
                    model.destroy(options);
                    // options.success(model);
                    break;
                }
            }
        }),

        SourcePhraseCollection = Backbone.Collection.extend({

            model: SourcePhrase,
            
            current: null,
            
            comparator: "order",

            resetFromDB: function () {
                window.Application.db.transaction(function (tx) {
                    tx.executeSql('CREATE TABLE IF NOT EXISTS sourcephrase (id INTEGER primary key, norder REAL, spid TEXT, chapterid TEXT, vid TEXT, markers TEXT, orig TEXT, prepuncts TEXT, midpuncts TEXT, follpuncts TEXT, flags char(22), texttype INTEGER, gloss TEXT, freetrans TEXT, note TEXT, srcwordbreak TEXT, tgtwordbreak TEXT, source TEXT, target TEXT);');
                }, function (err) {
                    console.log("resetFromDB: CREATE TABLE error: " + err.message);
                });
            },
            
            setCurrent: function (index) {
                if (index > -1 && index < this.size()) {
                    this.current = this.at(index);
                } else {
                    console.log('setCurrent: cannot set index: ' + index);
                }
            },
            prev: function () {
                this.setCurrent(this.at(this.current) - 1);
            },
            next: function () {
                this.setCurrent(this.at(this.current) + 1);
            },
            
            initialize: function () {
                this.resetFromDB();
                if (this.size() > 0) {
                    this.setCurrent(0);
                }
            },

            // Deletes all duplicate entries from the table
            cleanDuplicates: function() {
                //DELETE FROM sourcephrase WHERE rowid NOT IN (SELECT min(rowid) FROM sourcephrase GROUP BY spid);
                window.Application.db.transaction(function (tx) {
                    tx.executeSql("DELETE FROM sourcephrase WHERE rowid NOT IN (SELECT min(rowid) FROM sourcephrase GROUP BY spid);");
                }, function (err) {
                    console.log("cleanDuplicates() error: " + err.message);
                });            
            },
    
            // Removes all sourcephrases from the collection (and database)
            clearAll: function () {
                window.Application.db.transaction(function (tx) {
                    tx.executeSql('DELETE from sourcephrase;', [], function (tx, res) {
                        console.log("sourcephrase DELETE (all) ok.");
                        sourcephrases.length = 0;
                    }, function (tx, err) {
                        console.log("sourcephrase DELETE (all) error: " + err.message);
                    });
                }, function (err) {
                    console.log("DELETE error: " + err.message);
                });
            },
            
            // Remove just the local sourcephrases from the collection --
            // this keeps the in-memory objects to a minimum
            clearLocal: function () {
                sourcephrases.length = 0;
            },

            // Delete the specified models from the DB --
            // Note that clearLocal() should be called after this to clear the in-memory objects, 
            // followed by a read() to get a fresh copy of the "real" DB objects
            deleteBatch: function (models) {
                var deferred = $.Deferred();
                var sql = "DELETE FROM sourcephrase WHERE vid=(?);";
                var start = new Date().getTime();
                console.log("deleteBatch: " + models.length + " objects");
                window.Application.db.transaction(function (tx) {
                    Underscore.each(models, function (sp) {
                        tx.executeSql(sql, [sp.attributes.vid]);
                    });
                    var end = new Date().getTime();
                    console.log("deleteBatch: " + models.length + " objects, " + (end - start));
                }, function (e) {
                    deferred.reject(e);
                }, function () {
                    deferred.resolve();
                });
                return deferred.promise();
            },
            
            // add an array of SourcePhrase objects
            addBatch: function (models) {
                var deferred = $.Deferred();
                var sql = "INSERT INTO sourcephrase (spid, norder, chapterid, vid, markers, orig, prepuncts, midpuncts, follpuncts, flags, texttype, gloss, freetrans, note, srcwordbreak, tgtwordbreak, source, target) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);";
                var start = new Date().getTime();
                console.log("addBatch: " + models.length + " objects");
                console.log("> first word: " + models[0].attributes.source + ", last word: " + models[models.length - 1].attributes.source);
                window.Application.db.transaction(function (tx) {
                    Underscore.each(models, function (sp) {
                        tx.executeSql(sql, [sp.attributes.spid, sp.attributes.norder, sp.attributes.chapterid, sp.attributes.vid, sp.attributes.markers, sp.attributes.orig, sp.attributes.prepuncts, sp.attributes.midpuncts, sp.attributes.follpuncts, sp.attributes.flags, sp.attributes.texttype, sp.attributes.gloss, sp.attributes.freetrans, sp.attributes.note, sp.attributes.srcwordbreak, sp.attributes.tgtwordbreak, sp.attributes.source, sp.attributes.target]);
                    });
                    var end = new Date().getTime();
                    console.log("addBatch: " + models.length + " objects, " + (end - start));
                }, function (e) {
                    deferred.reject(e);
                }, function () {
                    deferred.resolve();
                });
                return deferred.promise();
            },

            sync: function (method, model, options) {
                var len = 0;
                var i = 0;
                var retValue = null;
                var deferred = null;
                var results = null;
                var sql = "";
                switch (method) {
                case 'create':
                    options.success(model);
                    break;
                        
                case 'read':
                    if (options.data.hasOwnProperty('spid')) {
                        // find specific source phrase
                        findById(options.data.spid).done(function (data) {
                            options.success(data);
                        });
                    } else if (options.data.hasOwnProperty('source')) {
                        // find all instances of a specific translation
                        deferred = $.Deferred();
                        var src = options.data.source;
                        sql = "SELECT * FROM sourcephrase WHERE source LIKE '%" + options.data.source + "%' ORDER BY norder;";
                        // ALWAYS retrieve this dataset from the db
                        window.Application.db.transaction(function (tx) {
                            tx.executeSql(sql, [], function (tx, res) {
                                // populate the sourcephrases collection with the query results
                                for (i = 0, len = res.rows.length; i < len; ++i) {
                                    var sp = new SourcePhrase();
                                    sp.off("change");
                                    sp.set(res.rows.item(i));
                                    sourcephrases.push(sp);
                                    sp.on("change", sp.save, sp);
                                }
                                // return the filtered results (now that we have them)
                                console.log("SELECT ok: " + res.rows.length + " sourcephrases for source: " + src);
                                retValue = sourcephrases;
                                options.success(retValue);
                                deferred.resolve(retValue);
                            });
                        }, function (e) {
                            options.error();
                            deferred.reject(e);
                        });
                    } else if (options.data.hasOwnProperty('chapterid')) {
                        // find all sourcephrase for the selected chapter
                        // (might need to get them from the db)
                        deferred = $.Deferred();
                        var chapterid = options.data.chapterid;
                        if (Array.isArray(chapterid)) { 
                            // multiple chapter value (comma separated)
                            // not in collection -- retrieve them from the db
                            window.Application.db.transaction(function (tx) {
                                var i = 0;
                                var ids = [];
                                var args = "";
                                if (chapterid.length > 1) {
                                    for (i = 0; i < chapterid.length; i++) {
                                        ids.push("\"" + chapterid[i] + "\"");
                                    }
                                    args = ids.join(", ");
                                } else {
                                    args = "\"" + chapterid[0] + "\"";
                                }
                                var sql = "SELECT * FROM sourcephrase WHERE chapterid IN (" + args + ") ORDER BY norder;";
                                console.log("SELECT statement: " + sql);
                                tx.executeSql(sql, [], function (tx, res) {
                                        // populate the sourcephrases collection with the query results
                                    for (i = 0, len = res.rows.length; i < len; ++i) {
                                        var sp = new SourcePhrase();
                                        sp.off("change");
                                        sp.set(res.rows.item(i));
                                        sourcephrases.push(sp);
                                        sp.on("change", sp.save, sp);
                                    }
                                    // return the filtered results (now that we have them)
                                    console.log("SELECT [MULTIPLE] ok: " + res.rows.length + " sourcephrases for chapterids: " + chapterid);
                                    retValue = sourcephrases;
                                    options.success(retValue);
                                    deferred.resolve(retValue);
                                }, function (e) {
                                    console.log("SELECT sourcephrase error: " + e);
                                    options.error();
                                    deferred.reject(e);
                                });
                            }, function (e) {
                                console.log("SELECT error: " + e);
                                options.error();
                                deferred.reject(e);
                            });
                        } else {
                            // single chapter value
                            results = sourcephrases.filter(function (element) {
                                return element.attributes.chapterid.toLowerCase().indexOf(chapterid.toLowerCase()) > -1;
                            });
                            if (results.length === 0) {
                                // not in collection -- retrieve them from the db
                                window.Application.db.transaction(function (tx) {
                                    tx.executeSql("SELECT * FROM sourcephrase WHERE chapterid=? ORDER BY norder;", [chapterid], function (tx, res) {
                                        // populate the sourcephrases collection with the query results
                                        for (i = 0, len = res.rows.length; i < len; ++i) {
                                            var sp = new SourcePhrase();
                                            sp.off("change");
                                            sp.set(res.rows.item(i));
                                            sourcephrases.push(sp);
                                            sp.on("change", sp.save, sp);
                                        }
                                        // return the filtered results (now that we have them)
                                        console.log("SELECT [SINGLE] ok: " + res.rows.length + " sourcephrases for chapterid: " + chapterid);
                                        retValue = sourcephrases;
                                        options.success(retValue);
                                        deferred.resolve(retValue);
                                    });
                                }, function (e) {
                                    options.error();
                                    deferred.reject(e);
                                });
                            } else {
                                // results already in collection -- return them
                                console.log("sync: found " + results.length + " sourcephrases for chapterid: " + chapterid);
                                options.success(results);
                                deferred.resolve(results);
                            }
                            // return the promise
                            return deferred.promise();
                        }
                    } else {
                        return Backbone.sync.apply(this, arguments);
                    }
                    break;
                        
                case 'update':
                    options.success(model);
                    break;
                        
                case 'delete':
                    options.success(model);
                    break;
                }
            }

        });
    
    return {
        SourcePhrase: SourcePhrase,
        SourcePhraseCollection: SourcePhraseCollection
    };

});