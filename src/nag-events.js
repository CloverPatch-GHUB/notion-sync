const { Client } = require('@notionhq/client');
const https = require('https');

const notion = new Client({
  auth: process.env.NOTION_API_TOKEN,
});

const DATABASE_ID = process.env.NOTION_EVENTS_DATABASE_ID;
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;

// Slack user IDs
const USERS = {
  winter: process.env.SLACK_USER_WINTER,
  summer: process.env.SLACK_USER_SUMMER,
  rav: process.env.SLACK_USER_RAV,
};

// Send Slack DM
async function sendSlackDM(userId, message) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      channel: userId,
      text: message,
    });

    const options = {
      hostname: 'slack.com',
      path: '/api/chat.postMessage',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SLACK_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const result = JSON.parse(data);
        if (result.ok) {
          console.log(`Sent DM to user ${userId}`);
          resolve(result);
        } else {
          console.error(`Failed to send DM: ${result.error}`);
          reject(new Error(result.error));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Check if event is missing info
function isMissingInfo(event) {
  const props = event.properties;
  const hasTime = props['Date & Time']?.date?.start?.includes('T');
  const hasLocation = props['Location']?.rich_text?.[0]?.plain_text;
  const hasDescription = props['Description']?.rich_text?.[0]?.plain_text;

  return !hasTime || !hasLocation || !hasDescription;
}

// Determine what's missing
function getMissingFields(event) {
  const props = event.properties;
  const missing = [];
  
  const hasTime = props['Date & Time']?.date?.start?.includes('T');
  const hasLocation = props['Location']?.rich_text?.[0]?.plain_text;
  const hasDescription = props['Description']?.rich_text?.[0]?.plain_text;

  if (!hasTime) missing.push('time');
  if (!hasLocation) missing.push('location');
  if (!hasDescription) missing.push('description');

  return missing;
}

// Get who to ask next (rotation: Winter → Summer → Rav)
function getNextPerson(nagCount) {
  const rotation = ['winter', 'summer', 'rav'];
  return rotation[nagCount % 3];
}

// Query events that need nagging
async function queryEventsNeedingNag() {
  console.log('Querying for events needing nag...');
  
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      and: [
        {
          property: 'Status',
          select: {
            equals: 'Scheduled',
          },
        },
        {
          or: [
            {
              property: 'Nag Status',
              select: {
                is_empty: true,
              },
            },
            {
              property: 'Nag Status',
              select: {
                equals: 'Pending',
              },
            },
          ],
        },
      ],
    },
  });

  // Filter for events that are actually missing info
  const needsNag = response.results.filter(event => isMissingInfo(event));
  console.log(`Found ${needsNag.length} events needing nag`);
  return needsNag;
}

// Check if enough time has passed since last nag
function shouldNagNow(event) {
  const props = event.properties;
  const nagCount = props['Nag Count']?.number || 0;
  const lastNagged = props['Last Nagged']?.date?.start;

  // Give up after 5 nags
  if (nagCount >= 5) {
    return { should: false, reason: 'max_attempts' };
  }

  // First nag: 1 hour after being scheduled
  if (nagCount === 0) {
    const lastEdited = new Date(props['Last edited time']);
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    
    if (lastEdited < hourAgo) {
      return { should: true, reason: 'first_nag' };
    }
    return { should: false, reason: 'too_soon' };
  }

  // Subsequent nags: every 2 hours
  if (lastNagged) {
    const lastNagTime = new Date(lastNagged);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    
    if (lastNagTime < twoHoursAgo) {
      return { should: true, reason: 'follow_up' };
    }
    return { should: false, reason: 'too_soon' };
  }

  return { should: true, reason: 'unknown_state' };
}

// Build nag message
function buildNagMessage(event, person) {
  const props = event.properties;
  const eventName = props['Event Name']?.title?.[0]?.plain_text || 'Untitled Event';
  const dateStr = props['Date & Time']?.date?.start || 'Unknown date';
  const missing = getMissingFields(event);
  const nagCount = (props['Nag Count']?.number || 0) + 1;

  const greeting = person === 'winter' ? '🌿 Hey Winter!' : 
                   person === 'summer' ? '🌸 Hey Summer!' : 
                   '🍀 Hey Rav!';

  return `${greeting}

I need some info about this event:
📅 **${eventName}** (${dateStr})

Missing: ${missing.join(', ')}

Can you fill in the missing details in Notion? Or reply "don't know" if you don't have this info.

(Attempt ${nagCount}/5)`;
}

// Update Notion with nag status
async function updateNagStatus(eventId, person, nagCount) {
  await notion.pages.update({
    page_id: eventId,
    properties: {
      'Nag Count': {
        number: nagCount,
      },
      'date:Last Nagged:start': new Date().toISOString(),
      'date:Last Nagged:is_datetime': 1,
      'Nag Status': {
        select: {
          name: 'Pending',
        },
      },
      'Asked Who': {
        rich_text: [
          {
            text: {
              content: person,
            },
          },
        ],
      },
    },
  });
}

// Main logic
async function main() {
  try {
    console.log('Starting event nagging check...');
    
    const events = await queryEventsNeedingNag();

    for (const event of events) {
      const shouldNag = shouldNagNow(event);
      
      if (!shouldNag.should) {
        console.log(`Skipping event ${event.id}: ${shouldNag.reason}`);
        
        // If max attempts, mark as gave up
        if (shouldNag.reason === 'max_attempts') {
          await notion.pages.update({
            page_id: event.id,
            properties: {
              'Nag Status': {
                select: {
                  name: 'Gave Up',
                },
              },
            },
          });
        }
        continue;
      }

      const nagCount = (event.properties['Nag Count']?.number || 0);
      const person = getNextPerson(nagCount);
      const userId = USERS[person];

      console.log(`Nagging ${person} about event ${event.id}`);

      try {
        const message = buildNagMessage(event, person);
        await sendSlackDM(userId, message);
        await updateNagStatus(event.id, person, nagCount + 1);
        console.log(`Successfully nagged ${person}`);
      } catch (error) {
        console.error(`Failed to nag about event ${event.id}:`, error.message);
      }
    }

    console.log('Nagging check complete!');
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

main();
