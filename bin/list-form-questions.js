#!/usr/bin/env node
'use strict';

// Lists every question in a Google Form with its questionId, type, and options.
// Usage:
//   node bin/list-form-questions.js <formId> [serviceAccountKeyPath]
//
// formId is the long string in the form URL between /forms/d/ and /edit
// (or /viewform). serviceAccountKeyPath defaults to ./service-account.json.

const path = require('path');
const { google } = require('googleapis');

async function main() {
  const [, , formIdArg, keyPathArg] = process.argv;
  if (!formIdArg) {
    console.error('Usage: node bin/list-form-questions.js <formId> [serviceAccountKeyPath]');
    process.exit(1);
  }
  const keyFile = path.resolve(process.cwd(), keyPathArg || './service-account.json');

  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/forms.body.readonly'],
  });
  const forms = google.forms({ version: 'v1', auth });

  const res = await forms.forms.get({ formId: formIdArg });
  const info = res.data.info || {};
  console.log(`Form: ${info.title || '(no title)'}\n`);

  const items = res.data.items || [];
  for (const item of items) {
    const title = item.title || '(no title)';

    // ── Plain single question ────────────────────────────────────────────────
    const q = item.questionItem && item.questionItem.question;
    if (q) {
      const qid = q.questionId;
      let kind = 'unknown';
      let options = [];
      if (q.choiceQuestion) {
        kind = q.choiceQuestion.type || 'CHOICE';
        options = (q.choiceQuestion.options || []).map((o) => o.value);
      } else if (q.textQuestion) {
        kind = 'TEXT';
      } else if (q.scaleQuestion) {
        kind = 'SCALE';
      } else if (q.dateQuestion) {
        kind = 'DATE';
      } else if (q.timeQuestion) {
        kind = 'TIME';
      }
      console.log(`• ${title}`);
      console.log(`    questionId: ${qid}`);
      console.log(`    type:       ${kind}`);
      if (options.length) console.log(`    options:    ${options.join(' | ')}`);
      console.log('');
      continue;
    }

    // ── Multiple-choice grid (questionGroupItem) ─────────────────────────────
    const grp = item.questionGroupItem;
    if (grp) {
      const gridType = (grp.grid && grp.grid.columns && grp.grid.columns.type) || 'GRID';
      const colOptions = (grp.grid && grp.grid.columns && grp.grid.columns.options || [])
        .map((o) => o.value);
      console.log(`• ${title}  [GRID / ${gridType}]`);
      console.log(`    columns: ${colOptions.join(' | ')}`);
      for (const rowQ of (grp.questions || [])) {
        const rowTitle = (rowQ.rowQuestion && rowQ.rowQuestion.title) || '(row)';
        console.log(`    row "${rowTitle}"  questionId: ${rowQ.questionId}`);
      }
      console.log('');
      continue;
    }

    // ── Other item types (section, image, video, …) ──────────────────────────
    console.log(`• ${title}  (no question — skipped)`);
  }
}

main().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
