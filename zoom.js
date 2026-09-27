const fs = require('fs');
const axios = require('axios');

const ACCOUNT_ID =
  process.env.ZOOM_ACCOUNT_ID;

const CLIENT_ID =
  process.env.ZOOM_CLIENT_ID;

const CLIENT_SECRET =
  process.env.ZOOM_CLIENT_SECRET;

const API =
  'https://api.zoom.us/v2';

if (
  !ACCOUNT_ID ||
  !CLIENT_ID ||
  !CLIENT_SECRET
) {
  console.error(
    '[ERR] Missing Zoom credentials.'
  );

  process.exit(1);
}

// ============================================================
// ZOOM OAUTH
// ============================================================

async function getAccessToken() {
  const credentials =
    Buffer
      .from(
        `${CLIENT_ID}:${CLIENT_SECRET}`
      )
      .toString('base64');

  const response =
    await axios.post(
      'https://zoom.us/oauth/token',

      new URLSearchParams({
        grant_type:
          'account_credentials',

        account_id:
          ACCOUNT_ID
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
// DATE HELPERS
// ============================================================

function formatDate(date) {
  return date
    .toISOString()
    .slice(0, 10);
}

function addDays(date, days) {
  const result =
    new Date(date);

  result.setUTCDate(
    result.getUTCDate() + days
  );

  return result;
}

// ============================================================
// GET RECORDINGS FOR DATE RANGE
// ============================================================

async function getRecordings(
  accessToken,
  from,
  to
) {
  const recordings = [];

  let nextPageToken = '';

  do {
    const params = {
      from,
      to,
      page_size: 300
    };

    if (nextPageToken) {
      params.next_page_token =
        nextPageToken;
    }

    const response =
      await axios.get(
        `${API}/accounts/${ACCOUNT_ID}/recordings`,
        {
          headers: {
            Authorization:
              `Bearer ${accessToken}`
          },

          params
        }
      );

    const meetings =
      response.data.meetings || [];

    recordings.push(
      ...meetings
    );

    nextPageToken =
      response.data.next_page_token ||
      '';

  } while (nextPageToken);

  return recordings;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  try {
    const accessToken =
      await getAccessToken();

    /*
     * Search a large historical window.
     *
     * Zoom's recording APIs have date-range
     * limitations, so we search in small chunks.
     *
     * Change HISTORY_DAYS if you want more/less.
     */

    const HISTORY_DAYS = 365;

    const today =
      new Date();

    const firstDate =
      addDays(
        today,
        -HISTORY_DAYS
      );

    const allRecordings = [];

    let current =
      firstDate;

    while (
      current < today
    ) {
      const rangeEnd =
        addDays(
          current,
          30
        );

      const end =
        rangeEnd > today
          ? today
          : rangeEnd;

      const from =
        formatDate(current);

      const to =
        formatDate(end);

      const recordings =
        await getRecordings(
          accessToken,
          from,
          to
        );

      allRecordings.push(
        ...recordings
      );

      current =
        addDays(
          end,
          1
        );
    }

    // ========================================================
    // REMOVE DUPLICATES
    // ========================================================

    const unique =
      new Map();

    for (
      const recording
      of allRecordings
    ) {
      const key =
        `${recording.id}-${recording.uuid || ''}`;

      unique.set(
        key,
        recording
      );
    }

    const recordings =
      Array.from(
        unique.values()
      );

    // ========================================================
    // ONLY RECORDINGS THAT HAVE FILES
    // ========================================================

    const ready =
      recordings.filter(
        recording => {
          const files =
            recording.recording_files ||
            [];

          return files.some(
            file =>
              file.status ===
              'completed'
          );
        }
      );

    // ========================================================
    // WRITE URLS + METADATA
    // ========================================================

    const urls = [];

    const metadata = [];

    for (
      const recording
      of ready
    ) {
      if (
        !recording.share_url
      ) {
        continue;
      }

      urls.push(
        recording.share_url
      );

      metadata.push({
        id:
          String(
            recording.id
          ),

        uuid:
          recording.uuid ||
          null,

        topic:
          recording.topic ||
          'Cloud Recording',

        start_time:
          recording.start_time ||
          null,

        host_id:
          recording.host_id ||
          null,

        type:
          recording.type ||
          null,

        share_url:
          recording.share_url,

        recording_files:
          recording.recording_files ||
          []
      });
    }

    fs.writeFileSync(
      'urls.txt',
      urls.length
        ? `${urls.join('\n')}\n`
        : '',
      'utf8'
    );

    fs.writeFileSync(
      'zoom-recordings.json',
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
