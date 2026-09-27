const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { pipeline } = require("stream/promises");
const { google } = require("googleapis");

const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;
const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;

const YOUTUBE_CLIENT_ID =
  process.env.YOUTUBE_CLIENT_ID;

const YOUTUBE_CLIENT_SECRET =
  process.env.YOUTUBE_CLIENT_SECRET;

const YOUTUBE_REFRESH_TOKEN =
  process.env.YOUTUBE_REFRESH_TOKEN;

const VIDEO_VISIBILITY =
  process.env.VIDEO_VISIBILITY || "unlisted";

const ZOOM_TIMEZONE =
  process.env.ZOOM_TIMEZONE || "UTC";

const RECORDINGS_FILE =
  "zoom-recordings.json";

const DOWNLOAD_DIR =
  path.join(process.cwd(), "zoom-downloads");

if (
  !ZOOM_ACCOUNT_ID ||
  !ZOOM_CLIENT_ID ||
  !ZOOM_CLIENT_SECRET
) {
  console.error(
    "[ERR] Missing Zoom credentials."
  );
  process.exit(1);
}

if (
  !YOUTUBE_CLIENT_ID ||
  !YOUTUBE_CLIENT_SECRET ||
  !YOUTUBE_REFRESH_TOKEN
) {
  console.error(
    "[ERR] Missing YouTube credentials."
  );
  process.exit(1);
}

function safeFileName(value) {
  return String(value)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
}

function formatRecordingDate(startTime) {
  if (!startTime) {
    return "Unknown Date";
  }

  try {
    const date = new Date(startTime);

    return new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone: ZOOM_TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }
    ).format(date);
  } catch {
    return startTime.slice(0, 10);
  }
}

function getFileName(file) {
  return (
    file.file_name ||
    file.file_path ||
    `${file.id || Date.now()}.mp4`
  );
}

function getGroupKey(file) {
  if (file.recording_start) {
    return file.recording_start;
  }

  const name = getFileName(file);

  const gmtMatch =
    name.match(/GMT\d+-\d+/i);

  if (gmtMatch) {
    return gmtMatch[0];
  }

  return file.id || name;
}

function fileScore(file) {
  const name =
    getFileName(file).toLowerCase();

  let score = 0;

  if (name.includes("1280x720")) {
    score += 1000000000;
  }

  if (name.includes("_avo_")) {
    score -= 100000000;
  }

  if (name.includes("_as_")) {
    score -= 10000000;
  }

  score += Number(file.file_size || 0);

  return score;
}

function selectVideoFiles(recording) {
  const files = Array.isArray(
    recording.recording_files
  )
    ? recording.recording_files
    : [];

  const mp4Files = files.filter((file) => {
    const type = String(
      file.file_type || ""
    ).toUpperCase();

    const extension = String(
      file.file_extension || ""
    ).toUpperCase();

    return (
      file.status === "completed" &&
      Boolean(file.download_url) &&
      (type === "MP4" ||
        extension === "MP4")
    );
  });

  const groups = new Map();

  for (const file of mp4Files) {
    const key = getGroupKey(file);

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(file);
  }

  const selected = [];

  for (const filesInGroup of groups.values()) {
    filesInGroup.sort(
      (a, b) =>
        fileScore(b) -
        fileScore(a)
    );

    selected.push(
      filesInGroup[0]
    );
  }

  selected.sort((a, b) => {
    const aTime =
      new Date(
        a.recording_start || 0
      ).getTime();

    const bTime =
      new Date(
        b.recording_start || 0
      ).getTime();

    return aTime - bTime;
  });

  return selected;
}

async function getZoomAccessToken() {
  try {
    const body = new URLSearchParams({
      grant_type: "account_credentials",
      account_id: ZOOM_ACCOUNT_ID
    }).toString();

    const response = await axios.post(
      "https://zoom.us/oauth/token",
      body,
      {
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },
        auth: {
          username: ZOOM_CLIENT_ID,
          password: ZOOM_CLIENT_SECRET
        }
      }
    );

    return response.data.access_token;
  } catch (error) {
    console.error(
      "[ERR] Zoom authentication failed:",
      error.response?.data ||
        error.message
    );

    throw error;
  }
}

async function downloadZoomFile(
  file,
  destination
) {
  let token =
    await getZoomAccessToken();

  try {
    const response =
      await axios.get(
        file.download_url,
        {
          headers: {
            Authorization:
              `Bearer ${token}`
          },
          responseType: "stream"
        }
      );

    await pipeline(
      response.data,
      fs.createWriteStream(
        destination
      )
    );

    return;
  } catch (error) {
    if (
      error.response?.status !== 401
    ) {
      throw error;
    }
  }

  token =
    await getZoomAccessToken();

  const response =
    await axios.get(
      file.download_url,
      {
        headers: {
          Authorization:
            `Bearer ${token}`
        },
        responseType: "stream"
      }
    );

  await pipeline(
    response.data,
    fs.createWriteStream(
      destination
    )
  );
}

function createYouTubeClient() {
  const oauth2Client =
    new google.auth.OAuth2(
      YOUTUBE_CLIENT_ID,
      YOUTUBE_CLIENT_SECRET
    );

  oauth2Client.setCredentials({
    refresh_token:
      YOUTUBE_REFRESH_TOKEN
  });

  return google.youtube({
    version: "v3",
    auth: oauth2Client
  });
}

async function uploadToYouTube(
  youtube,
  filePath,
  title,
  description
) {
  const response =
    await youtube.videos.insert({
      part: [
        "snippet",
        "status"
      ],
      requestBody: {
        snippet: {
          title,
          description,
          categoryId: "22"
        },
        status: {
          privacyStatus:
            VIDEO_VISIBILITY,
          selfDeclaredMadeForKids:
            false
        }
      },
      media: {
        body: fs.createReadStream(
          filePath
        )
      }
    });

  if (!response.data.id) {
    throw new Error(
      "YouTube upload completed without returning a video ID."
    );
  }

  return response.data.id;
}

async function deleteZoomRecording(
  meetingId
) {
  if (!meetingId) {
    throw new Error(
      "Zoom meeting ID is missing."
    );
  }

  const token =
    await getZoomAccessToken();

  try {
    await axios.delete(
      `https://api.zoom.us/v2/meetings/${encodeURIComponent(
        meetingId
      )}/recordings`,
      {
        headers: {
          Authorization:
            `Bearer ${token}`
        }
      }
    );
  } catch (error) {
    console.error(
      "[ERR] Zoom recording deletion failed:",
      error.response?.data ||
        error.message
    );

    throw error;
  }
}

async function processRecording(
  youtube,
  recording,
  index,
  total
) {
  const files =
    selectVideoFiles(recording);

  if (files.length === 0) {
    console.error(
      `[SKIP] No completed MP4 files for recording ${recording.meeting_id}.`
    );

    return;
  }

  const topic =
    recording.topic ||
    "Untitled Zoom Recording";

  const recordingDate =
    formatRecordingDate(
      recording.start_time
    );

  const baseTitle =
    `Cloud Recording - ${topic} - ${recordingDate}`;

  console.error(
    `[INFO] Processing recording ${index}/${total}: ${topic}`
  );

  console.error(
    `[INFO] Selected video files: ${files.length}`
  );

  const uploadedVideos = [];

  for (
    let i = 0;
    i < files.length;
    i++
  ) {
    const file = files[i];

    const partTitle =
      files.length > 1
        ? `${baseTitle} - Part ${i + 1}/${files.length}`
        : baseTitle;

    const localName =
      `${String(index).padStart(4, "0")}-${String(
        i + 1
      ).padStart(2, "0")}-${safeFileName(
        topic
      )}.mp4`;

    const localPath =
      path.join(
        DOWNLOAD_DIR,
        localName
      );

    console.error(
      `[INFO] Downloading part ${i + 1}/${files.length}`
    );

    await downloadZoomFile(
      file,
      localPath
    );

    const description =
      `Zoom Cloud Recording\n\n` +
      `Topic: ${topic}\n` +
      `Recording date: ${recordingDate}\n` +
      `Zoom meeting ID: ${recording.meeting_id}\n` +
      `${
        recording.share_url
          ? `Zoom recording: ${recording.share_url}\n`
          : ""
      }`;

    console.error(
      `[INFO] Uploading to YouTube: ${partTitle}`
    );

    const youtubeVideoId =
      await uploadToYouTube(
        youtube,
        localPath,
        partTitle,
        description
      );

    uploadedVideos.push(
      youtubeVideoId
    );

    console.error(
      `[OK] YouTube upload successful: ${youtubeVideoId}`
    );

    if (fs.existsSync(localPath)) {
      fs.unlinkSync(localPath);
    }
  }

  if (
    uploadedVideos.length !==
    files.length
  ) {
    throw new Error(
      "Not all recording files were uploaded. Zoom recording will not be deleted."
    );
  }

  console.error(
    `[INFO] All YouTube uploads succeeded for Zoom recording ${recording.meeting_id}.`
  );

  console.error(
    `[INFO] Deleting Zoom recording ${recording.meeting_id}.`
  );

  await deleteZoomRecording(
    recording.meeting_id
  );

  console.error(
    `[OK] Zoom recording deleted: ${recording.meeting_id}`
  );
}

async function main() {
  if (
    !fs.existsSync(
      RECORDINGS_FILE
    )
  ) {
    console.error(
      `[ERR] ${RECORDINGS_FILE} was not created.`
    );

    process.exit(1);
  }

  const recordings =
    JSON.parse(
      fs.readFileSync(
        RECORDINGS_FILE,
        "utf8"
      )
    );

  if (
    !Array.isArray(recordings) ||
    recordings.length === 0
  ) {
    console.error(
      "[OK] No Zoom recordings to process."
    );

    return;
  }

  fs.mkdirSync(
    DOWNLOAD_DIR,
    {
      recursive: true
    }
  );

  const youtube =
    createYouTubeClient();

  console.error(
    `[INFO] Total recordings to process: ${recordings.length}`
  );

  for (
    let i = 0;
    i < recordings.length;
    i++
  ) {
    await processRecording(
      youtube,
      recordings[i],
      i + 1,
      recordings.length
    );
  }

  console.error(
    "[OK] All Zoom recordings processed successfully."
  );
}

main().catch((error) => {
  console.error(
    "[ERR] Processing failed:",
    error.response?.data ||
      error.message
  );

  process.exit(1);
});
