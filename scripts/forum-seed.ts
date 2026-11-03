import { parseArgs } from 'node:util';
import { pool, transaction } from '../server/db.ts';
import { realm } from '../server/accounts.ts';

// The forum's categories and starter threads. Safe to run again: categories are updated in place and a
// thread that already exists is left alone, along with its replies. npm run forum:seed -- --author <username>
type Starter = { title: string, body: string, pinned?: boolean, record?: string };
const CATEGORIES: { id: string, name: string, description: string, threads: Starter[] }[] = [
  { id:'general', name:'General Watch Discussion', description:'General conversation about watches, collecting, opinions, new releases, and everything else horological.', threads:[
    { title:'What are you wearing today?', body:'What is on your wrist, and why did you pick it this morning?' },
    { title:'Recent acquisitions', body:'Bought something lately? Tell us what it is, how you found it, and what you think of it now you have lived with it.' },
    { title:'Watches that changed your perspective', body:'Which watch changed how you think about watches? It could be one you own, one you handled once, or one you only read about.' },
    { title:'Unpopular watch opinions', body:'What do you believe about watches that most collectors would argue with? Make the case.' },
  ] },
  { id:'watchmaking', name:'Watchmaking & Manufacturing', description:'Explore how watches are produced, from movement development and component sourcing to finishing, assembly, and regulation.', threads:[
    { title:'Who actually manufactures Swiss watch cases?', body:'Case makers rarely appear in a brand\'s own story. What do we know about who makes them, and what sources show it?' },
    { title:'The major movement suppliers explained', body:'Use this thread to map the major movement suppliers: who makes what, who buys from whom, and how those relationships have changed. Please cite your sources.' },
    { title:'How much manufacturing does "Swiss Made" require?', body:'What does the label require in practice, what does it leave out, and where do readers commonly misunderstand it? Link to the rules where you can.' },
    { title:'Hand finishing vs. machine finishing', body:'How can you tell them apart, and how much does the difference matter to you? Close-up photographs and references are welcome.' },
  ] },
  { id:'brands', name:'Brands & Watchmakers', description:'Discussions about specific brands, independent watchmakers, their histories, production methods, and technical developments.', threads:[
    { title:'Independent watchmakers worth researching', body:'Which independents deserve a closer look, and what makes their work interesting? Say what you know first-hand and what you have read.' },
    { title:'Understanding the NOMOS manufacturing model', body:'What does NOMOS make itself, what does it buy in, and how is that documented? Share what you have found.' },
    { title:'Who are the most overlooked contemporary watchmakers?', body:'Who is doing serious work without getting much attention? Name them and explain why they should get more.' },
  ] },
  { id:'research', name:'Research & Discoveries', description:'A collaborative space for original research, historical documents, patents, supplier relationships, vintage reference identification, and lesser-known watchmaking history.', threads:[
    { title:'Share interesting watchmaking patents', body:'Found a patent worth reading? Post the number, a link, and what it shows.' },
    { title:'Historical movement manufacturer relationships', body:'Use this thread to collect evidence of who supplied whom over time. Catalogues, ledgers, advertisements and caseback marks are all useful; please say where each one comes from.' },
    { title:'Help identify an unknown caliber', body:'Post clear photographs of the movement, along with any markings and measurements, and say what you have already ruled out.' },
    { title:'The watchmaking research archive', body:'A running list of useful archives, books, scanned catalogues and reference sites. Add a link and say what each is good for.' },
  ] },
  { id:'falk-index', name:'FALK Index Discussion', description:'Discuss specific records, scoring decisions, production archetypes, classification boundaries, and the methodology itself.', threads:[
    { title:'Understanding the eight archetypes', body:'Which archetypes make sense to you, and which are hard to apply? Examples from the records help most.\n\nThe archetypes: https://falkindex.com/archetypes/' },
    { title:'What separates an Artisan Atelier from an Artisan Établisseur?', body:'Where should the line between these two fall, and which records sit closest to it?' },
    { title:'Should manufacturing scale affect classification?', body:'Should the number of watches a maker produces change how it is classified, or should the classification look only at where the work is done?' },
    { title:'Discussing the J.N. Shapiro Infinity vs. Resurgence', record:'jn-shapiro/infinity', body:'What do the differences between these two records tell us, and do you agree with them? Please point to the evidence.\n\nThe Infinity: https://falkindex.com/records/jn-shapiro/infinity/\nThe Resurgence: https://falkindex.com/records/jn-shapiro/resurgence/' },
  ] },
  { id:'community', name:'Community & Announcements', description:'Introductions, forum updates, community guidelines, suggestions, and feedback on FALK Index.', threads:[
    { title:'Welcome to the FALK Forum', pinned:true, body:'This is where collectors, journalists and watchmakers can discuss watches, how they are made, and the FALK Index itself. Anyone can read, and you can post with your FALK Index account.' },
    { title:'Forum rules and research standards', pinned:true, body:'Be civil, and argue with the claim rather than the person. Say where a claim about how a watch is made comes from, and separate what you know first-hand from what you have heard.\n\nUse Report on any post that needs a moderator. Moderators hide posts rather than delete them, and each decision is recorded with a reason.' },
    { title:'Introduce yourself', body:'Who are you, and what brought you here? Collectors, journalists, watchmakers and the simply curious are all welcome.' },
    { title:'Feature requests and feedback', body:'What should the forum or FALK Index do better? Tell us what you were trying to do and what got in the way.' },
  ] },
];

const { values: { author } } = parseArgs({ options:{ author:{ type:'string' } } });
if (!author) throw new Error('Usage: npm run forum:seed -- --author <username of an administrator>');
try {
  const created = await transaction(async db => {
    const account = (await db.query('SELECT id FROM falk_account WHERE realm=$1 AND lower(username)=lower($2) AND deleted_at IS NULL', [realm(),author])).rows[0];
    if (!account) throw new Error(`No account has the username ${author}.`);
    let count = 0;
    for (const [position,c] of CATEGORIES.entries()) {
      await db.query(`INSERT INTO falk_forum_category(id,name,description,position) VALUES($1,$2,$3,$4)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,position=excluded.position`, [c.id,c.name,c.description,position]);
      for (const t of c.threads) {
        if ((await db.query('SELECT 1 FROM falk_forum_thread WHERE category_id=$1 AND title=$2', [c.id,t.title])).rowCount) continue;
        const thread = (await db.query('INSERT INTO falk_forum_thread(category_id,author_id,title,watch_id,pinned) VALUES($1,$2,$3,$4,$5) RETURNING id',
          [c.id,account.id,t.title,t.record ?? null,!!t.pinned])).rows[0].id;
        await db.query('INSERT INTO falk_forum_post(thread_id,author_id,body) VALUES($1,$2,$3)', [thread,account.id,t.body]);
        count++;
      }
    }
    return count;
  });
  console.log(`Forum ready: ${CATEGORIES.length} categories, ${created} new threads.`);
} finally { await pool.end(); }
