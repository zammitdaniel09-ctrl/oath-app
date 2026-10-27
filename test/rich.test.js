// The coach's Markdown: the app's HTML, Telegram's HTML and plain text for notifications.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { richHtml, telegramHtml, plainText } from '../public/rich.js';

const REPLY = "Morning. It's 08:58.\n\n- **Today's one thing:** the bike at 16:00\n- *Futsal* at 19:30\n\n1. Pump\n2. Patch\nThen ride.";

test('bold, italics, lists and paragraphs become HTML', () => {
  assert.equal(richHtml(REPLY),
    '<p>Morning. It&#39;s 08:58.</p>'
    + '<ul><li><strong>Today&#39;s one thing:</strong> the bike at 16:00</li><li><em>Futsal</em> at 19:30</li></ul>'
    + '<ol><li>Pump</li><li>Patch</li></ol><p>Then ride.</p>');
  assert.equal(richHtml('one\ntwo'), '<p>one<br>two</p>', 'single line breaks stay inside a paragraph');
  assert.equal(richHtml('__bold__ and _soft_ and `code`'), '<p><strong>bold</strong> and <em>soft</em> and <code>code</code></p>');
  assert.equal(richHtml('3. three\n4. four'), '<ol start="3"><li>three</li><li>four</li></ol>');
  assert.equal(richHtml('## Plan'), '<p><strong>Plan</strong></p>', 'headings are just bold lines');
});

test('only its own tags get through, and maths and names are left alone', () => {
  assert.equal(richHtml('<img src=x onerror=alert(1)> **<b>hi</b>**'), '<p>&lt;img src=x onerror=alert(1)&gt; <strong>&lt;b&gt;hi&lt;/b&gt;</strong></p>');
  assert.equal(richHtml('2 * 3 * 4 = 24, snake_case_name, a ** b'), '<p>2 * 3 * 4 = 24, snake_case_name, a ** b</p>');
  assert.equal(richHtml(''), '');
  assert.equal(richHtml(null), '');
});

test('Telegram gets its small HTML set and notifications get plain text', () => {
  assert.equal(telegramHtml(REPLY), "Morning. It's 08:58.\n\n• <b>Today's one thing:</b> the bike at 16:00\n• <i>Futsal</i> at 19:30\n\n1. Pump\n2. Patch\n\nThen ride.");
  assert.equal(telegramHtml('a < b & **c**'), 'a &lt; b &amp; <b>c</b>');
  assert.equal(plainText(REPLY), "Morning. It's 08:58.\n\n• Today's one thing: the bike at 16:00\n• Futsal at 19:30\n\n1. Pump\n2. Patch\n\nThen ride.");
});
