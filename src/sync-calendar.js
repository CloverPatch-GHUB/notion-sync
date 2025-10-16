const { Client } = require('@notionhq/client');
const { google } = require('googleapis');

const notion = new Client({
  auth: process.env.NOTION_API_TOKEN,
});

const DATABASE_ID = process.env.NOTION_EVENTS_DATABASE_ID;

const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/calendar'],
});

const calendar = google.calendar({ version: 'v3', auth });

async function shareCalendar() {
  console.log('Sharing service account calendar with rav@threeleafclover.us...');
  
  try {
    await calendar.acl.insert({
      calendarId: 'primary',
      requestBody: {
        role: 'reader',
        scope: {
          type: 'user',
          value: 'rav@threeleafclover.us',
        },
      },
    });
    console.log('Calendar shared successfully');
  } catch (error) {
    if (error.message.includes('duplicate')) {
      console.log('Calendar already shared');
    } else {
      console.log('Note: Could not share calendar, but will continue');
    }
  }
}

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
  const startTime = properties['Date & Time']?.date?.start;
  const endTime = properties['Date & Time']?.date?.end;
  
  console.log(`Creating calendar event: ${title}`);
  
  const event = {
    summary: title,
    description: description,
    location: location,
    start: {
      dateTime: startTime,
      timeZone: 'America/Los_Angeles',
    },
    end: {
      dateTime: endTime || startTime,
      timeZone: 'America/Los_Angeles',
    },
  };
  
  const calendarResponse = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: event,
  });
  
  console.log(`Created: ${title} (Calendar ID: ${calendarResponse.data.id})`);
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
              content: `Synced to Google Calendar on ${new Date().toISOString()}`,
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
    console.log('Starting calendar sync...');
    
    // Share calendar first
    await shareCalendar();
    
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
