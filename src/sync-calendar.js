const { Client } = require('@notionhq/client');
const { google } = require('googleapis');

const notion = new Client({
  auth: process.env.NOTION_API_TOKEN,
});

const DATABASE_ID = process.env.NOTION_EVENTS_DATABASE_ID;
const CALENDAR_ID = 'rav@threeleafclover.us';

// Load service account credentials and set up domain-wide delegation
const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/calendar'],
  clientOptions: {
    subject: 'rav@threeleafclover.us',
  },
});

const calendar = google.calendar({ version: 'v3', auth });

async function queryApprovedEvents() {
  console.log('Querying Notion for Approved events...');
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      property: 'Status',
      select: {
        equals: 'Approved',
      },
    },
  });
  console.log(`Found ${response.results.length} approved events`);
  return response.results;
}

async function createCalendarEvent(notionPage) {
  const properties = notionPage.properties;
  const title = properties['Event Name']?.title[0]?.plain_text || 'Untitled Event';
  const description = properties['Description']?.rich_text[0]?.plain_text || '';
  const location = properties['Location']?.rich_text[0]?.plain_text || '';
  const dateInfo = properties['Date & Time']?.date;
  
  if (!dateInfo || !dateInfo.start) {
    throw new Error('Date & Time is required');
  }

  console.log(`Creating calendar event: ${title}`);

  const event = {
    summary: title,
    description: description,
    location: location,
  };

  // Check if this is an all-day event or has specific time
  const hasTime = dateInfo.start.includes('T');
  
  if (hasTime) {
    // Event with specific time
    event.start = {
      dateTime: dateInfo.start,
      timeZone: 'America/Los_Angeles',
    };
    event.end = {
      dateTime: dateInfo.end || dateInfo.start,
      timeZone: 'America/Los_Angeles',
    };
  } else {
    // All-day event (no time specified)
    event.start = {
      date: dateInfo.start.split('T')[0], // Just the date part
    };
    
    if (dateInfo.end) {
      event.end = {
        date: dateInfo.end.split('T')[0],
      };
    } else {
      // Single day event - end date is next day for Google Calendar
      const nextDay = new Date(dateInfo.start);
      nextDay.setDate(nextDay.getDate() + 1);
      event.end = {
        date: nextDay.toISOString().split('T')[0],
      };
    }
  }

  const calendarResponse = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: event,
  });

  console.log(`Created: ${title} (Calendar ID: ${calendarResponse.data.id}, Type: ${hasTime ? 'Timed' : 'All-day'})`);
  return calendarResponse.data.id;
}

async function updateNotionEvent(pageId, calendarEventId) {
  console.log(`Updating Notion page with Calendar ID...`);
  await notion.pages.update({
    page_id: pageId,
    properties: {
      'Calendar ID': {
        rich_text: [
          {
            text: {
              content: calendarEventId,
            },
          },
        ],
      },
      'Status': {
        select: {
          name: 'Scheduled',
        },
      },
      'Notes': {
        rich_text: [
          {
            text: {
              content: `Synced to calendar on ${new Date().toISOString()}`,
            },
          },
        ],
      },
    },
  });
  console.log(`Updated Notion page to Scheduled status`);
}

async function main() {
  try {
    console.log('Starting calendar sync with service account key...');
    const approvedEvents = await queryApprovedEvents();

    if (approvedEvents.length === 0) {
      console.log('No approved events to sync.');
      return;
    }

    for (const event of approvedEvents) {
      try {
        const calendarEventId = await createCalendarEvent(event);
        await updateNotionEvent(event.id, calendarEventId);
      } catch (error) {
        console.error(`Error syncing event ${event.id}:`, error.message);
        await notion.pages.update({
          page_id: event.id,
          properties: {
            'Notes': {
              rich_text: [
                {
                  text: {
                    content: `Error syncing: ${error.message}`,
                  },
                },
              ],
            },
          },
        });
      }
    }

    console.log('Sync complete!');
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main();
