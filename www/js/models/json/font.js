/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50 */
/*global define */

define(function (require) {

    "use strict";

    var Backbone = require('backbone'),

        Font = Backbone.Model.extend({

        }),

        FontCollection = Backbone.Collection.extend({

            model: Font,

            url: "/fonts"

        });

    return {
        Font: Font,
        FontCollection: FontCollection
    };

});