import { App } from '@slack/bolt';
import { MessageAttachment, LinkUnfurls } from '@slack/web-api';
import { APIResponseError, Client } from '@notionhq/client';
import { NotionToMarkdown } from 'notion-to-md';

const notionWorkspace = process.env.NOTION_WORKSPACE;
if (notionWorkspace === undefined) {
  console.error('NOTION_WORKSPACE is required');
}
const notionDomain = process.env.NOTION_DOMAIN ?? 'notion.so';
const summaryNumberOfLines = Number(process.env.SUMMARY_NUMBER_OF_LINES ?? '5');
const summaryNumberOfCharacters = Number(process.env.SUMMARY_NUMBER_OF_CHARACTERS ?? '200');
const notionIconUrl = "https://www.notion.so/front-static/favicon.ico";
const debug = process.env.DEBUG === '1';

export const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  customRoutes: [
    {
      path: '/health-check',
      method: ['GET'],
      handler: (_req, res) => {
        res.writeHead(200);
        res.end('OK');
      },
    },
  ],
});

const notionClient = new Client({
  auth: process.env.NOTION_API_TOKEN,
});
const n2m = new NotionToMarkdown({ notionClient: notionClient });

app.event('link_shared', async ({ event, client }) => {
  const conversation = await client.conversations.info({ channel: event.channel} );

  // TODO: Make this option
  // for safety guard
  if (conversation.channel?.is_shared) {
    return;
  }

  let linkUnfurls: LinkUnfurls = {};
  for (const link of event.links) {
    if (link.domain === notionDomain) {
      const attachment = await unfurlNotion(link.url).catch(err => {
        console.error(`Failed to unfurl ${link.url}: ${err}`);
        return null;
      })
      if (attachment !== null) {
        linkUnfurls[link.url] = attachment;
      }
    }
  }

  await client.chat.unfurl({ channel: event.channel, ts: event.message_ts, unfurls: linkUnfurls});
});

interface NotionPage {
  properties: NotionPageProperties;
  parent: NotionPageParent;
  icon?: NotionPageIcon;
}

interface NotionPageParent {
  type: 'database_id' | 'page_id'
}

interface NotionPageProperties {
  title?: NotionPagePropertyTitle;
  Name?: NotionPagePropertyTitle;
}

interface NotionPagePropertyTitle {
  title: NotionPropertyTitleValue[];
}

interface NotionPropertyTitleValue {
  plain_text: string;
}

interface NotionDatabase {
  icon?: NotionPageIcon
  title: NotionPropertyTitleValue[];
}

interface NotionPageIcon {
  type: string;
  emoji: string;
}

const unfurlNotion = async (urlStr: string): Promise<MessageAttachment | null> => {
  // XXX: unfurl input is escaped
  const url = new URL(urlStr.replace("&amp;", "&"));

  return await handlePageOrDatabase(url);
}

const handlePageOrDatabase = async (url: URL): Promise<MessageAttachment | null> => {
  const elems = url.pathname.split('/');
  if (elems.length !== 3) {
    throw new Error(`Unexpected pathname: ${url.pathname}`);
  }

  if (elems[1] !== notionWorkspace) {
    return null;
  }

  // Apply the following (undocumented) rules.
  // 
  // https://www.notion.so/workspace/0123456789abcdef0123456789abcdef
  //   => just a page
  // https://www.notion.so/workspace/0123456789abcdef0123456789abcdef?v=0123456789abcdef0123456789abcdef&p=0123456789abcdef0123456789abcdef 
  //   => a page preview in a database
  // https://www.notion.so/workspace/0123456789abcdef0123456789abcdef?v=0123456789abcdef0123456789abcdef
  //   => a full database page

  if (url.searchParams.has('p')) {
    const pageId = url.searchParams.get('p')!;
    return await handlePage(url.toString(), pageId);
  } 
  
  const decoratedPageId = elems[2];
  const m = decoratedPageId.match(/([^-]+)$/m);
  if (m === null) {
    return null;
  }
  const pageIdOrDatabaseId = m[1];

  if (url.searchParams.has('v')) {
    return await handleDatabase(url.toString(), pageIdOrDatabaseId);
  }

  return await handlePage(url.toString(), pageIdOrDatabaseId);
}

const handlePage = async (url: string, pageId: string): Promise<MessageAttachment> => {
  const rawPage = await notionClient.pages.retrieve({ page_id: pageId });
  const page = rawPage as unknown as NotionPage;

  if (debug) {
    console.debug(page);
  }

  let title: string | undefined;
  switch (page.parent.type) {
    case 'database_id': 
      title = page.properties.Name?.title[0].plain_text;
      break;
    case 'page_id':
      title = page.properties.title?.title[0].plain_text;
      break;
  }

  if (title === undefined) {
    throw new Error(`Failed to guess title from pageId: ${pageId}`);
  }

  const icon = page.icon?.emoji;
  if (icon !== undefined) {
    title = icon + ' ' + title;
  }

  const mdBlocks = await n2m.pageToMarkdown(pageId);
  const mdString = n2m.toMarkdownString(mdBlocks);
  let head = mdString.split('\n').filter(l => l.length > 0).slice(0, summaryNumberOfLines).join('\n');
  if (head.length >= summaryNumberOfCharacters) {
    head = head.substring(0, summaryNumberOfCharacters - 1) + '…';
  }

  return {
    author_icon: notionIconUrl,
    author_name: `${notionWorkspace}'s Notion`,
    title: title,
    title_link: url,
    text: head,
    footer: "Notion",
  };
}

const handleDatabase = async (url: string, databaseId: string): Promise<MessageAttachment> => {
  const rawDatabase = await notionClient.databases.retrieve({ database_id: databaseId });
  const database = (rawDatabase as unknown as NotionDatabase);

  if (debug) {
    console.debug(database);
  }

  let title = database.title[0].plain_text;
  if (title === undefined) {
    throw new Error(`Failed to guess title from databaseId: ${databaseId}`);
  }

  const icon = database.icon?.emoji;
  if (icon !== undefined) {
    title = icon + ' ' + title;
  }

  return {
    author_icon: notionIconUrl,
    author_name: `${notionWorkspace}'s Notion`,
    title: title,
    title_link: url,
    text: "This is a full database page.",
    footer: "Notion",
  };
}

(async () => {
  await app.start();
  console.log('⚡️ Bolt app started');
})();
