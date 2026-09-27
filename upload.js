const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { google } = require('googleapis');

const OAuth2 = google.auth.OAuth2;

// ============================================================
// ENVIRONMENT
// ============================================================

const youtubeClientId =
  process.env.YOUTUBE_CLIENT_ID;

const youtubeClientSecret =
  process.env.YOUTUBE_CLIENT_SECRET;

const youtubeRefreshToken =
  process.env.YOUTUBE_REFRESH_TOKEN;

const zoomAccountId =
  process.env.ZOOM_ACCOUNT_ID;

const zoomClientId =
  process.env.ZOOM_CLIENT_ID;

const zoomClientSecret =
  process.env.ZOOM_CLIENT_SECRET;

const privacyStatus =
  process.env.VIDEO_VISIBILITY ||
  'unlisted';

// ============================================================
// LOAD ZOOM METADATA
// ============================================================

if (!fs.existsSync('zoom-metadata.json')) {
  console.error(
    '[ERR] zoom-metadata.json not found.'
  );

  process.exit(1);
}

const zoomMetadata =
  JSON.parse(
    fs.readFileSync(
      'zoom-metadata.json',
      'utf8'
    )
  );

const webinarId =
  zoomMetadata.webinarId;

const zoomTitle =
  zoomMetadata.title ||
  'Cloud Recording';

const recordingDate =
  zoomMetadata.formattedDate ||
  'Unknown Date';

// ============================================================
// YOUTUBE AUTH
// ============================================================

if (
  !youtubeClientId ||
  !youtubeClientSecret ||
  !youtubeRefreshToken
) {
  console.error(
    '[ERR] Missing YouTube OAuth secrets.'
  );

  process.exit(1);
}

const oauth2Client =
  new OAuth2(
    youtubeClientId,
    youtubeClientSecret,
    'https://developers.google.com/oauthplayground'
  );

oauth2Client.setCredentials({
  refresh_token:
    youtubeRefreshToken
});

const youtube =
  google.youtube({
    version: 'v3',
    auth: oauth2Client
  });

// ============================================================
// FILE DISCOVERY
// ============================================================

function getAllMp4Files(
  dir,
  fileList = []
) {
  const items =
    fs.readdirSync(
      dir,
      {
        withFileTypes: true
      }
    );

  for (const item of items) {
    const fullPath =
      path.join(
        dir,
        item.name
      );

    if (
      item.isDirectory() &&
      item.name !== 'node_modules' &&
      !item.name.startsWith('.')
    ) {
      getAllMp4Files(
        fullPath,
        fileList
      );
    } else if (
      item.isFile() &&
      item.name
        .toLowerCase()
        .endsWith('.mp4')
    ) {
      fileList.push(fullPath);
    }
  }

  return fileList;
}

// ============================================================
// SELECT BEST QUALITY FILES
// ============================================================

function filterHighestQualityVideos(
  allFiles
) {
  if (allFiles.length === 1) {
    return allFiles;
  }

  const grouped = {};

  for (const filePath of allFiles) {
    const fileName =
      path.basename(filePath);

    if (
      fileName.includes('_avo_')
    ) {
      continue;
    }

    const match =
      fileName.match(
        /GMT\d+-\d+/
      );

    const key =
      match
        ? match[0]
        : filePath;

    if (!grouped[key]) {
      grouped[key] = [];
    }

    grouped[key].push(
      filePath
    );
  }

  const selectedFiles = [];

  for (
    const key in grouped
  ) {
    const group =
      grouped[key];

    let best =
      group.find(
        file =>
          file.endsWith(
            '1280x720.mp4'
          ) &&
          !file.includes('_as_')
      );

    if (!best) {
      best =
        group.find(
          file =>
            file.includes(
              '1280x720.mp4'
            )
        );
    }

    if (!best) {
      best =
        group.sort(
          (a, b) =>
            fs.statSync(b).size -
            fs.statSync(a).size
        )[0];
    }

    if (best) {
      selectedFiles.push(best);
    }
  }

  if (
    selectedFiles.length === 0
  ) {
    return allFiles;
  }

  return selectedFiles.sort(
    (a, b) =>
      path.basename(a)
        .localeCompare(
          path.basename(b)
        )
  );
}

// ============================================================
// YOUTUBE TITLE
// ============================================================

function createYoutubeTitle(
  partNumber,
  totalParts
) {
  let title =
    `Cloud Recording - ${zoomTitle} - ${recordingDate}`;

  if (totalParts > 1) {
    title +=
      ` - Part ${partNumber}/${totalParts}`;
  }

  return title;
}

// ============================================================
// YOUTUBE DESCRIPTION
// ============================================================

function createYoutubeDescription() {
  return [
    `Cloud recording: ${zoomTitle}`,
    `Recording date: ${recordingDate}`,
    `Zoom webinar ID: ${webinarId}`,
    '',
    'Uploaded automatically by Z2YLK02.'
  ].join('\n');
}

// ============================================================
// UPLOAD SINGLE VIDEO
// ============================================================

async function uploadSingleVideo(
  videoPath,
  videoTitle
) {
  const res =
    await youtube.videos.insert({
      part: 'snippet,status',

      requestBody: {
        snippet: {
          title: videoTitle,

          description:
            createYoutubeDescription(),

          categoryId: '22'
        },

        status: {
          privacyStatus:
            privacyStatus
        }
      },

      media: {
        body:
          fs.createReadStream(
            videoPath
          )
      }
    });

  if (
    !res.data ||
    !res.data.id
  ) {
    throw new Error(
      'YouTube did not return a video ID.'
    );
  }

  return res.data.id;
}

// ============================================================
// ZOOM AUTH
// ============================================================

async function getZoomAccessToken() {
  if (
    !zoomAccountId ||
    !zoomClientId ||
    !zoomClientSecret
  ) {
    throw new Error(
      'Missing Zoom OAuth secrets.'
    );
  }

  const credentials =
    Buffer
      .from(
        `${zoomClientId}:${zoomClientSecret}`
      )
      .toString('base64');

  const response =
    await axios.post(
      'https://zoom.us/oauth/token',

      new URLSearchParams({
        grant_type:
          'account_credentials',

        account_id:
          zoomAccountId
      }).toString(),

      {
        headers: {
          Authorization:
            `Basic ${credentials}`,

          'Content-Type':
            'application/x-www-form-urlencoded'
        }
      }
    );

  return response.data.access_token;
}

// ============================================================
// DELETE ZOOM RECORDING
// ============================================================

async function deleteZoomRecording() {
  const accessToken =
    await getZoomAccessToken();

  await axios.delete(
    `https://api.zoom.us/v2/accounts/${zoomAccountId}/meetings/${webinarId}/recordings`,
    {
      headers: {
        Authorization:
          `Bearer ${accessToken}`
      }
    }
  );
}

// ============================================================
// DELETE LOCAL FILE
// ============================================================

function deleteLocalFile(
  filePath
) {
  if (
    fs.existsSync(filePath)
  ) {
    fs.unlinkSync(filePath);
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const allFiles =
    getAllMp4Files(
      process.cwd()
    );

  if (
    allFiles.length === 0
  ) {
    console.error(
      '[ERR] No MP4 files found.'
    );

    process.exit(1);
  }

  const filesToUpload =
    filterHighestQualityVideos(
      allFiles
    );

  const uploadedVideos = [];

  // ----------------------------------------------------------
  // Upload every selected video
  // ----------------------------------------------------------

  try {
    for (
      let i = 0;
      i < filesToUpload.length;
      i++
    ) {
      const file =
        filesToUpload[i];

      const title =
        createYoutubeTitle(
          i + 1,
          filesToUpload.length
        );

      const videoId =
        await uploadSingleVideo(
          file,
          title
        );

      uploadedVideos.push({
        file,
        videoId,
        title
      });

      // Delete local MP4 only after
      // successful YouTube upload.
      deleteLocalFile(file);
    }
  } catch (error) {
    console.error(
      '[ERR] YouTube upload failed:',
      error.response?.data ||
      error.message ||
      error
    );

    // IMPORTANT:
    // Zoom recording remains untouched.
    process.exit(1);
  }

  // ----------------------------------------------------------
  // Verify ALL uploads succeeded
  // ----------------------------------------------------------

  if (
    uploadedVideos.length !==
    filesToUpload.length
  ) {
    console.error(
      '[ERR] Not all videos were uploaded.'
    );

    // DO NOT delete Zoom recording.
    process.exit(1);
  }

  // ----------------------------------------------------------
  // Delete Zoom recording
  // ----------------------------------------------------------

  try {
    await deleteZoomRecording();
  } catch (error) {
    console.error(
      '[ERR] YouTube upload succeeded, but Zoom deletion failed:',
      error.response?.data ||
      error.message ||
      error
    );

    // The YouTube uploads are safe.
    // Zoom recording remains available.
    process.exit(1);
  }

  // ----------------------------------------------------------
  // Cleanup any remaining MP4 files
  // ----------------------------------------------------------

  const remainingFiles =
    getAllMp4Files(
      process.cwd()
    );

  for (
    const file of remainingFiles
  ) {
    deleteLocalFile(file);
  }
}

main().catch(error => {
  console.error(
    '[FATAL]',
    error.response?.data ||
    error.message ||
    error
  );

  process.exit(1);
});
