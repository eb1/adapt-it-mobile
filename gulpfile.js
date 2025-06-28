// Gulpfile for Adapt It Mobile builds
var fs = require("fs"),
    path = require("path"),
    cp = require('child_process'),
    terser = require("gulp-terser"),
    del = require("del"),
    log = require("fancy-log"),
    cordova = require("cordova-lib").cordova;

const { series, parallel } = require('gulp');
const { src, dest } = require('gulp');

const paths = {
    js_src: './www/js/**/*',
    js_src_files: './www/js/***/*.js',
    js_dest: './www/js',
    js_bak: './www_js_bak'
};

// --- Minification Tasks ---

// Backup the original JS files to a temporary directory
function backup_js() {
    log('Backing up js files to ' + paths.js_bak + '\n');
    return src(paths.js_src).pipe(dest(paths.js_bak));
};

// Minify JS files in place for the build
function minify_js() {
    log('Calling terser on js files\n');
    return src(paths.js_src_files).pipe(terser()).pipe(dest(paths.js_dest));
};

// Restore the original JS files from backup
function restore_js() {
    log('Restoring js files from ' + paths.js_bak + '\n');
    return del.deleteAsync([paths.js_dest]).then(() => {
        return src(paths.js_bak + '/**/*').pipe(dest(paths.js_dest));
    });
};

// Clean up the backup folder
function clean_backup() {
    log('Cleaning backup files\n');
    return del.deleteAsync([paths.js_bak]);
};

// prep the Android platform -- either add it or clean it
function prep_android_dir (done) {
    var path = "./platforms/android";
    if (!fs.existsSync(path)) {
        log('Android dir not detected -- creating platform android\n');
        var cmd = cp.spawn('cordova', ["platform", "add", "android"], {stdio: 'inherit'}).on('exit', done);
    } else {
        log('cleaning platform android\n');
        var cmd = cp.spawn('cordova', ["clean", "android"], {stdio: 'inherit'}).on('exit', done);
    }
};

// prep the iOS platform -- either add it or clean it
function prep_ios_dir (done) {
    var path = "./platforms/ios";
    if (!fs.existsSync(path)) {
        log('ios dir not detected -- creating platform ios\n');
        var cmd = cp.spawn('cordova', ["platform", "add", "ios@latest"], {stdio: 'inherit'}).on('exit', done);
    } else {
        log('cleaning platform ios\n');
        var cmd = cp.spawn('cordova', ["clean", "ios"], {stdio: 'inherit'}).on('exit', done);
    }
};

function buildAndRestore (platform, done) {
    const cordovaBuild = (cb) => {
        let options = { platforms: [platform] };
        if (platform === 'android') {
            options.options = {
                argv: ["--release", "--verbose", "--buildConfig=build.json", "--gradleArg=--no-daemon"]
            };
        } else if (platform === 'ios') {
            options.options = {
                argv: ["--release", "--verbose", "--buildConfig=build.json", "--device"]
            };
        }
        cordova.build(options, cb);
    };

    // const restoreTasks = series(restore_js, clean_backup);

    // Wrap cordova build in a promise to handle success and failure
    new Promise((resolve, reject) => {
        cordovaBuild((err) => {
            if (err) return reject(err);
            resolve();
        });
    }).then(() => {
        console.log(`Cordova build for ${platform} succeeded. Restoring JS files.`);
        done();
    }).catch((err) => {
        console.error(`Cordova build for ${platform} failed, but restoring JS files.`);
        done(err); // Signal gulp that the task failed
    });
};

function copyAndroidArtifact() {
    // Copy results to bin folder
    return src("platforms/android/app/build/outputs/apk/release/*.apk").pipe(dest("bin/release/android"));
};

// --- Main Build Tasks ---
function build_ios(done) {
    buildAndRestore('ios');
    done();
};

function build_android(done) {
    buildAndRestore('android');
    done();
}

// build both Android and iOS
exports.build = series(
    parallel(prep_android_dir, prep_ios_dir),
    backup_js,
    minify_js,
    parallel(build_android, build_ios),
    restore_js,
    clean_backup,
    copyAndroidArtifact
);
exports.ios = series(
    prep_ios_dir,
    backup_js,
    minify_js,
    build_ios,
    restore_js,
    clean_backup,
);
// default - just Android
exports.android = series(
    prep_android_dir,
    backup_js,
    minify_js,
    build_android, 
    restore_js,
    clean_backup,
    copyAndroidArtifact
); // also called by CI build
exports.default = this.android;