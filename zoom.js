const fs = require('fs');
const axios = require('axios');

const ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;
const CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;

const WEBINAR_ID =
  process.env.ZOOM_WEBINAR_ID ||
  extractWebinarId(process.env.ZOOM_URL);

function extractWebinarId(url) {
  if (!url) return null;

  const matches = url.match(/\d{8,}/g);

  if (!matches || matches.length === 0) {
    return null;
  }

  return matches[matches.length - 1];
}

if (!ACCOUNT_ID || !CLIENT_ID || !CLIENT_SECRET) {
  console.error('[ERR] Missing Zoom OAuth secrets.');
  process.exit(1);
}

if (!WEBINAR_ID) {
  console.error('[ERR] No webinar ID found.');
  console.error(
    '[ERR] Send webinar_id in client_payload.'
  );
  process.exit(1);
}

async function getZoomAccessToken() {
  const credentials = Buffer
    .from(`${CLIENT_ID}:${CLIENT_SECRET}`)
    .toString('base64');

  const response = await axios.post(
    'https://zoom.us/oauth/token',

    new URLSearchParams({
      grant_type: 'account_credentials',
      account_id: ACCOUNT_ID
    }).toString(),

    {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type':
          'application/x-www-form-urlencoded'
      }
    }
  );

  return response.data.access_token;
}

async function getWebinar(accessToken) {
  const response = await axios.get(
    `https://api.zoom.us/v2/webinars/${WEBINAR_ID}`,
    {
      headers: {
        Authorization:
          `Bearer ${accessToken}`
      }
    }
  );

  return response.data;
}

async function getRecording(accessToken) {
  const response = await axios.get(
    `https://api.zoom.us/v2/webinars/${WEBINAR_ID}/recordings`,
    {
      headers: {
        Authorization:
          `Bearer ${accessToken}`
      }
    }
  );

  return response.data;
}

function formatDate(dateString, timezone) {
  const date = new Date(dateString);

  if (Number.isNaN(date.getTime())) {
    return dateString;
  }

  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

async function main() {
  try {
    const accessToken =
      await getZoomAccessToken();

    const webinar =
      await getWebinar(accessToken);

    const recording =
      await getRecording(accessToken);

    if (
      !recording ||
      !recording.share_url
    ) {
      console.error(
        '[ERR] No cloud recording available.'
      );

      process.exit(1);
    }

    const recordingFiles =
      recording.recording_files || [];

    const completedFiles =
      recordingFiles.filter(
        file => file.status === 'completed'
      );

    if (completedFiles.length === 0) {
      console.error(
        '[ERR] Recording files are not completed yet.'
      );

      process.exit(1);
    }

    fs.writeFileSync(
      'urls.txt',
      `${recording.share_url}\n`,
      'utf8'
    );

    const metadata = {
      webinarId: String(WEBINAR_ID),

      title:
        webinar.topic ||
        recording.topic ||
        'Cloud Recording',

      startTime:
        webinar.start_time ||
        recording.start_time,

      timezone:
        webinar.timezone ||
        'UTC',

      formattedDate:
        formatDate(
          webinar.start_time ||
          recording.start_time,
          webinar.timezone
        ),

      shareUrl:
        recording.share_url
    };

    fs.writeFileSync(
      'zoom-metadata.json',
      JSON.stringify(
        metadata,
        null,
        2
      ),
      'utf8'
    );

  } catch (error) {
    console.error(
      '[ERR] Zoom API error:',
      error.response?.data ||
      error.message
    );

    process.exit(1);
  }
}

main();
