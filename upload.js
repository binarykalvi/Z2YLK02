const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { google } = require('googleapis');

const OAuth2 =
  google.auth.OAuth2;

// ============================================================
// ENV
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
// LOAD METADATA
// ============================================================

if (
  !fs.existsSync(
    'zoom-recordings.json'
  )
) {
  console.error(
    '[ERR] zoom-recordings.json not found.'
  );

  process.exit(1);
}

const zoomRecordings =
  JSON.parse(
    fs.readFileSync(
      'zoom-recordings.json',
      'utf8'
    )
  );

// ============================================================
// YOUTUBE AUTH
// ============================================================

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
// FIND MP4
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

  for (
    const item of items
  ) {
    const fullPath =
      path.join(
        dir,
        item.name
      );

    if (
      item.isDirectory() &&
      item.name !==
        'node_modules' &&
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
      fileList.push(
        fullPath
      );
    }
  }

  return fileList;
}

// ============================================================
// FORMAT DATE
// ============================================================

function formatRecordingDate(
  dateString
) {
  if (!dateString) {
    return 'Unknown Date';
  }

  const date =
    new Date(dateString);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return dateString;
  }

  return new Intl.DateTimeFormat(
    'en-GB',
    {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'UTC'
    }
  ).format(date);
}

// ============================================================
// FIND BEST MP4
// ============================================================

function chooseBestFiles(
  files
) {
  const mp4 =
    files.filter(
      file =>
        file
          .toLowerCase()
          .endsWith('.mp4')
    );

  if (
    mp4.length === 0
  ) {
    return [];
  }

  if (
    mp4.length === 1
  ) {
    return mp4;
  }

  const selected =
    mp4.filter(
      file =>
        file.includes(
          '1280x720'
        ) &&
        !file.includes(
          '_as_'
        ) &&
        !file.includes(
          '_avo_'
        )
    );

  if (
    selected.length
  ) {
    return selected;
  }

  return mp4;
}

// ============================================================
// YOUTUBE TITLE
// ============================================================

function makeTitle(
  recording,
  part,
  total
) {
  const topic =
    recording.topic ||
    'Cloud Recording';

  const date =
    formatRecordingDate(
      recording.start_time
    );

  let title =
    `Cloud Recording - ${topic} - ${date}`;

  if (
    total > 1
  ) {
    title +=
      ` - Part ${part}/${total}`;
  }

  return title;
}

// ============================================================
// DESCRIPTION
// ============================================================

function makeDescription(
  recording
) {
  return [
    `Cloud Recording`,
    `Title: ${recording.topic || 'Cloud Recording'}`,
    `Recording Date: ${formatRecordingDate(recording.start_time)}`,
    `Zoom Recording: ${recording.share_url}`,
    '',
    'Uploaded automatically by Z2YLK02.'
  ].join('\n');
}

// ============================================================
// UPLOAD
// ============================================================

async function uploadVideo(
  file,
  title,
  description
) {
  const response =
    await youtube.videos.insert({
      part:
        'snippet,status',

      requestBody: {
        snippet: {
          title,
          description,
          categoryId:
            '22'
        },

        status: {
          privacyStatus
        }
      },

      media: {
        body:
          fs.createReadStream(
            file
          )
      }
    });

  if (
    !response.data ||
    !response.data.id
  ) {
    throw new Error(
      'YouTube upload did not return a video ID.'
    );
  }

  return response.data.id;
}

// ============================================================
// ZOOM TOKEN
// ============================================================

async function getZoomToken() {
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

async function deleteZoomRecording(
  recording
) {
  const token =
    await getZoomToken();

  await axios.delete(
    `https://api.zoom.us/v2/meetings/${encodeURIComponent(recording.id)}/recordings`,
    {
      headers: {
        Authorization:
          `Bearer ${token}`
      }
    }
  );
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const mp4Files =
    getAllMp4Files(
      process.cwd()
    );

  /*
   * No MP4 files means nothing was downloaded.
   * This is a successful "nothing to do" situation.
   */

  if (
    mp4Files.length === 0
  ) {
    process.exit(0);
  }

  /*
   * We need to map downloaded files back to
   * recordings. zoom-rec-dl normally preserves
   * the recording naming information.
   *
   * Process recordings sequentially.
   */

  let fileIndex = 0;

  for (
    const recording
    of zoomRecordings
  ) {
    const recordingFiles =
      chooseBestFiles(
        mp4Files.slice(
          fileIndex
        )
      );

    if (
      recordingFiles.length === 0
    ) {
      continue;
    }

    /*
     * Upload files belonging to this recording.
     */

    const uploaded = [];

    try {
      for (
        let i = 0;
        i < recordingFiles.length;
        i++
      ) {
        const file =
          recordingFiles[i];

        const title =
          makeTitle(
            recording,
            i + 1,
            recordingFiles.length
          );

        const description =
          makeDescription(
            recording
          );

        const videoId =
          await uploadVideo(
            file,
            title,
            description
          );

        uploaded.push({
          file,
          videoId
        });
      }
    } catch (error) {
      console.error(
        '[ERR] YouTube upload failed:',
        error.response?.data ||
        error.message ||
        error
      );

      /*
       * IMPORTANT:
       *
       * Do NOT delete Zoom recording
       * if YouTube upload failed.
       */

      process.exit(1);
    }

    /*
     * All files for this recording
     * successfully uploaded.
     */

    try {
      await deleteZoomRecording(
        recording
      );
    } catch (error) {
      console.error(
        '[ERR] Could not delete Zoom recording:',
        error.response?.data ||
        error.message
      );

      /*
       * YouTube upload succeeded,
       * but Zoom deletion failed.
       *
       * Do not pretend deletion happened.
       */

      process.exit(1);
    }

    /*
     * Delete local files after
     * successful YouTube + Zoom processing.
     */

    for (
      const item of uploaded
    ) {
      if (
        fs.existsSync(
          item.file
        )
      ) {
        fs.unlinkSync(
          item.file
        );
      }
    }

    fileIndex +=
      recordingFiles.length;
  }

  /*
   * Remove any remaining MP4 files.
   */

  const remaining =
    getAllMp4Files(
      process.cwd()
    );

  for (
    const file of remaining
  ) {
    if (
      fs.existsSync(file)
    ) {
      fs.unlinkSync(file);
    }
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
