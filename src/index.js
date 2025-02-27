#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const glob = require('glob');
const jimp = require('jimp');
const plist = require('plist');
const icns = require('icns-lib');
const {
    program
} = require('commander');
const {
    default: fetch
} = require('node-fetch');

const jpeg = require('./openjpeg');
const {
    version
} = require('../package.json');

jimp.decoders['image/jp2'] = (buffer) => {
    const {
        width,
        height,
        data
    } = jpeg(buffer, 'jp2');

    // Convert Planar RGB into Pixel RGB
    const rgbaBuffer = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) {
        rgbaBuffer[i] = data[(data.length / 4) * (i % 4) + Math.round(i / 4)] || 0;
    }
    return {
        width,
        height,
        data: rgbaBuffer
    };
};

const fileicon = path.join(os.tmpdir(), `fileicon-${Math.random().toFixed(16).substr(2, 6)}.sh`);
const fileiconBinaryReady = new Promise(resolve => {
    fs.createReadStream(path.join(__dirname, 'fileicon.sh'))
        .pipe(fs.createWriteStream(fileicon), {
            end: true
        })
        .on('close', resolve);
}).then(() => cp.spawnSync('chmod', ['+x', fileicon]));

process.on('unhandledRejection', (e) => {
    throw e
});
process.on('uncaughtException', (e) => {
    console.error('Error:', e.message);
    process.exit(1);
});

program.name('iconsur');
program.version(version);
program.option('-l, --local', 'Directly create an icon locally without searching for an iOS App');
program.option('-k, --keyword <keyword>', 'Specify custom keyword to search for an iOS App');
program.option('-r, --region <region>', 'Specify country or region to search (default: us)');
program.option('-s, --scale <float>', 'Specify scale for adaptive icon (default: 0.9)');
program.option('-c, --color <hex>', 'Specify color for adaptive icon (default: ffffff)');
program.option('-i, --input <path>', 'Specify custom input image for adaptive icon');
program.option('-p, --padding <float>', 'Specify custom padding for adaptive icon (default: 100)');
program.option('-d, --direct', 'Directly replace input image without scale and generate');
program.option('-o, --output <path>', 'Write the generated icon to a file without actually applying to App');

program.command('set <dir> [otherDirs...]').action(async (dir, otherDirs) => {
    if (!otherDirs.length && ~dir.indexOf('*')) {
        [dir, ...otherDirs] = glob.sync(dir);
    }

    for (let appDir of [dir, ...otherDirs]) {
        console.log(`Processing ${appDir}...`);

        appDir = path.resolve(process.cwd(), appDir);
        if (!fs.statSync(appDir).isDirectory()) {
            console.error(`${appDir}: No such directory`);
            process.exit(1);
        }

        if (!appDir.endsWith('.app')) {
            console.error(`${appDir}: Not an App directory`);
            process.exit(1);
        }

        let appName = program.keyword;
        let srcIconFile = program.input;
        console.log(`program.input ${srcIconFile}...`);
        if (program.input) {
            program.local = true;
        }

        try {
            const infoPlist = path.join(appDir, 'Contents/Info.plist');

            // Convert potentially binary plist to xml format
            const convertedPlist = path.resolve(os.tmpdir(), `tmp-${Math.random().toFixed(16).substr(2, 6)}.plist`);
            cp.spawnSync('plutil', ['-convert', 'xml1', '-o', convertedPlist, '--', infoPlist]);

            const infoPlistContents = plist.parse(fs.readFileSync(convertedPlist, 'utf-8'));
            if (!appName) {
                appName = infoPlistContents['CFBundleDisplayName'] || path.basename(appDir).replace(/\.app$/, '');
            }
            if (!srcIconFile) {
                srcIconFile = path.resolve(appDir, 'Contents/Resources', infoPlistContents['CFBundleIconFile']);
                if (!/\.icns$/.test(srcIconFile)) {
                    srcIconFile += '.icns';
                }
            }
        } catch (e) {
            console.log(`Plist file might be corrupted; using fallback name and AppIcon.icns as default icon location.`);
            console.log('Re-run with option -k or --keyword to specify custom app name to search for.');
            console.log('Re-run with option -i or --input to specify custom input image for an adaptive icon.');

            if (!appName) {
                appName = path.basename(appDir).replace(/\.app$/, '');
            }
            if (!srcIconFile) {
                srcIconFile = path.resolve(appDir, 'Contents/Resources/AppIcon.icns');
            }
        }

        const imageSize = 1024;
        const iconPadding = program.direct ? 0 : 100;
        const iconSize = imageSize - 2 * iconPadding;
        const mask = (await jimp.read(path.join(__dirname, 'mask.png'))).resize(imageSize, imageSize);
        const region = program.region || 'us';

        let iconBuffer;
        let resultIcon;
        let data = null;

        if (!program.local) {
            console.log(`Searching iOS App with name: ${appName}`);
            const res = await fetch(`https://itunes.apple.com/search?media=software&entity=software%2CiPadSoftware&term=${encodeURIComponent(appName)}&country=${region}&limit=1`);
            data = await res.json();
        }

        if (data && data.results && data.results.length) {
            const app = data.results[0];
            const appName = app.trackName;
            const iconUrl = app.artworkUrl512 || app.artworkUrl100;
            console.log(`Found iOS app: ${appName} with icon: ${iconUrl}`);
            const result = await fetch(iconUrl);
            iconBuffer = await result.buffer();
            resultIcon = (await jimp.read(iconBuffer)).resize(iconSize, iconSize);
        } else {
            if (!program.local) {
                console.log(`Cannot find iOS App with name: ${appName}`);
            }

            console.log(`Generating adaptive icon...`);

            if (!fs.existsSync(srcIconFile)) {
                console.error(`Cannot find icon at ${srcIconFile}`);
                process.exit(1);
            }

            iconBuffer = fs.readFileSync(srcIconFile);

            try {
                const subIconBuffer = Object.entries(icns.parse(iconBuffer))
                    .filter(([k]) => icns.isImageType(k))
                    .map(([, v]) => v)
                    .sort((a, b) => b.length - a.length)[0];

                if (subIconBuffer) {
                    iconBuffer = subIconBuffer;
                }
            } catch (e) {}

            try {
                resultIcon = await jimp.read(iconBuffer);
            } catch (e) {
                console.error(`Failed to read original icon: ${e.message}`);
                console.error('Re-run with option -i or --input to use a custom image for generation.');
                process.exit(1);
            }
        }

        let originalIconScaleSize;
        // if (!program.direct) {
        originalIconScaleSize = parseFloat(program.scale || '1');
        resultIcon.contain(iconSize * originalIconScaleSize, iconSize * originalIconScaleSize);
        // } else {
        //     originalIconScaleSize = 1;
        //     resultIcon.cover(iconSize, iconSize);
        // }
        // console.log(`originalIconScaleSize: ${originalIconScaleSize}`);

        const scalePosition = iconSize * (1 - originalIconScaleSize) / 2;
        resultIcon = (await jimp.create(iconSize, iconSize)).composite(resultIcon, scalePosition, scalePosition);

        const image = (await jimp.create(imageSize, imageSize, program.color || '#ffffff')).composite(resultIcon, iconPadding, iconPadding);

        // The masking algorithm that is both alpha- and color-friendly and full of magic
        image.scan(0, 0, imageSize, imageSize, (x, y) => {
            image.setPixelColor((mask.getPixelColor(x, y) & image.getPixelColor(x, y)) >>> 0, x, y);
        });

        if (program.output) {
            program.output = String(program.output).replace(/(\..*)?$/, '.png');
            await image.writeAsync(program.output);
            console.log(`Successfully saved icon for ${appDir} at ${program.output}\n`);
        } else {
            const tmpFile = path.resolve(os.tmpdir(), `tmp-${Math.random().toFixed(16).substr(2, 6)}.png`);
            await image.writeAsync(tmpFile);

            await fileiconBinaryReady;
            const {
                status
            } = cp.spawnSync(fileicon, ['set', appDir, tmpFile], {
                stdio: 'inherit'
            });
            if (status) {
                console.error(`Failed to set custom icon: fileicon script exited with error ${status}`);
                process.exit(1);
            }
            console.log(`Successfully set icon for ${appDir}\n`);
        }
    };
});

program.command('unset <dir> [otherDirs...]').action(async (dir, otherDirs) => {
    if (!otherDirs.length && ~dir.indexOf('*')) {
        [dir, ...otherDirs] = glob.sync(dir);
    }

    await fileiconBinaryReady;
    for (let appDir of [dir, ...otherDirs]) {
        const {
            status
        } = cp.spawnSync(fileicon, ['rm', appDir], {
            stdio: 'inherit'
        });
        if (status) {
            console.error(`Failed to remove custom icon: fileicon script exited with error ${status}`);
            process.exit(1);
        }
    }
});

program.command('cache').action(() => {
    try {
        cp.execSync('sudo rm -rf /Library/Caches/com.apple.iconservices.store', {
            stdio: 'ignore'
        });
    } catch (e) {}

    try {
        cp.execSync('sudo find /private/var/folders/ \\( -name com.apple.dock.iconcache -or -name com.apple.iconservices \\) -exec rm -rf {} \\;', {
            stdio: 'ignore'
        });
    } catch (e) {}

    try {
        cp.execSync('sleep 3; sudo touch /Applications/*', {
            stdio: 'ignore'
        });
    } catch (e) {}

    try {
        cp.execSync('killall Dock', {
            stdio: 'ignore'
        });
    } catch (e) {}

    try {
        cp.execSync('killall Finder', {
            stdio: 'ignore'
        });
    } catch (e) {}

    process.exit();
});

program.parse(process.argv);
