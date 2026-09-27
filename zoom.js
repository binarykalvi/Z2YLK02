const axios = require("axios");
const fs = require("fs");

const ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;
const CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;

const HISTORY_DAYS = Number(
  process.env.ZOOM_HISTORY_DAYS || 3650
);

if (!ACCOUNT_ID || !CLIENT_ID || !CLIENT_SECRET) {
  console.error("[ERR] Missing Zoom credentials.");
  process.exit(1);
}

async function getZoomAccessToken() {
  try {
    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

    const body = new URLSearchParams({
      grant_type: "account_credentials",
      account_id: ACCOUNT_ID
    }).toString();

    const response = await axios.post(
      "https://zoom.us/oauth/token",
      body,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": `Basic ${credentials}`
        }
      }
    );

    if (!response.data.access_token) {
      console.error("[ERR] Zoom did not return an access token.");
      process.exit(1);
    }

    return response.data.access_token;
  } catch (error) {
    console.error(
      "[ERR] Zoom OAuth error:",
      error.response?.data || error.message
    );

    process.exit(1);
  }
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

async function getRecordingsForRange(token, from, to) {
  const recordings = [];
  let nextPageToken = "";

  do {
    try {
      const response = await axios.get(
        `https://api.zoom.us/v2/accounts/${encodeURIComponent(ACCOUNT_ID)}/recordings`,
        {
          headers: {
            Authorization: `Bearer ${token}`
          },
          params: {
            from: formatDate(from),
            to: formatDate(to),
            page_size: 300,
            next_page_token: nextPageToken || undefined
          }
        }
      );

      const meetings = response.data.meetings || [];
      recordings.push(...meetings);
      nextPageToken = response.data.next_page_token || "";
    } catch (error) {
      console.error(
        "[ERR] Zoom account recordings API error:",
        error.response?.data || error.message
      );
      process.exit(1);
    }
  } while (nextPageToken);

  return recordings;
}

function normalizeRecording(recording) {
  const files = Array.isArray(recording.recording_files)
    ? recording.recording_files
    : [];

  const mp4Files = files
    .filter((file) => {
      const fileType = String(file.file_type || "").toUpperCase();
      const extension = String(
        file.file_extension || ""
      ).toUpperCase();

      return (
        file.status === "completed" &&
        (fileType === "MP4" || extension === "MP4") &&
        Boolean(file.download_url)
      );
    })
    .map((file) => ({
      id: file.id || null,
      recording_type: file.recording_type || null,
      file_type: file.file_type || null,
      file_extension: file.file_extension || null,
      file_name: file.file_name || null,
      file_path: file.file_path || null,
      download_url: file.download_url,
      play_url: file.play_url || null,
      recording_start: file.recording_start || null,
      recording_end: file.recording_end || null,
      file_size: file.file_size || 0,
      status: file.status
    }));

  return {
    meeting_id: recording.id || null,
    uuid: recording.uuid || null,
    topic: recording.topic || "Untitled Zoom Recording",
    start_time: recording.start_time || null,
    timezone: recording.timezone || "UTC",
    duration: recording.duration || 0,
    recording_count: recording.recording_count || mp4Files.length,
    share_url: recording.share_url || null,
    host_id: recording.host_id || null,
    type: recording.type || null,
    status: recording.status || null,
    recording_files: mp4Files
  };
}

async function main() {
  const token = await getZoomAccessToken();
  console.error("[OK] Zoom authentication successful.");

  const today = new Date();
  const startDate = addDays(today, -HISTORY_DAYS);
  const allRecordings = [];

  let current = startDate;

  while (current <= today) {
    const rangeEnd = new Date(
      Math.min(
        addDays(current, 29).getTime(),
        today.getTime()
      )
    );

    const recordings = await getRecordingsForRange(
      token,
      current,
      rangeEnd
    );

    allRecordings.push(...recordings);
    current = addDays(rangeEnd, 1);
  }

  const unique = new Map();

  for (const recording of allRecordings) {
    const key =
      recording.uuid ||
      `${recording.id}-${recording.start_time}`;

    if (!unique.has(key)) {
      unique.set(
        key,
        normalizeRecording(recording)
      );
    }
  }

  const normalized = Array.from(unique.values());

  const completedRecordings = normalized.filter(
    (recording) =>
      recording.status === "completed" &&
      recording.recording_files.length > 0
  );

  fs.writeFileSync(
    "zoom-recordings.json",
    JSON.stringify(
      completedRecordings,
      null,
      2
    )
  );

  console.error(
    `[OK] Zoom recordings found: ${completedRecordings.length}`
  );

  if (completedRecordings.length === 0) {
    console.error(
      "[OK] No completed cloud recordings found."
    );
  }
}

main().catch((error) => {
  console.error(
    "[ERR] Unexpected Zoom error:",
    error.message
  );

  process.exit(1);
});
