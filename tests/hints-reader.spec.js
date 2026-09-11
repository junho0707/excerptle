import { test, expect } from '@playwright/test';

test('version-2 hints stay visible and a finished round opens its reading section', async ({ page }) => {
  const chapter = { puzzleId: 'g1342', label: 'Chapter 1', paragraphs: ['First chapter paragraph.', 'Second chapter paragraph.'] };
  await page.route('**/puzzles/g1342.json', async route => {
    const original = await route.fetch();
    const puzzle = await original.json();
    await route.fulfill({ json: {
      ...puzzle, hintVersion: 2, schemaVersion: 2,
      openingSentence: puzzle.texts[0], openingExcerpt: 'Opening paragraph one.\n\nOpening paragraph two.',
      genre: 'Novel of manners', setting: 'England, early 19th century',
      reading: { kind: 'chapter', label: 'Chapter 1', url: '/puzzles/reading/g1342.v2.json', wordCount: 6 },
    } });
  });
  await page.route('**/puzzles/reading/g1342.v2.json', route => route.fulfill({ json: chapter }));
  await page.goto('/#/play/600');
  await page.locator('#modal [data-act="close-modal"]').last().click();
  await expect(page.locator('#tier-label')).toHaveText('First sentence');
  await page.locator('#hint-btn').click();
  await expect(page.locator('#excerpt')).toContainText('Opening paragraph one.');
  await page.locator('#hint-btn').click();
  await expect(page.locator('#hint-facts')).toContainText('Novel of manners');
  await page.locator('#guess-input').fill('Pride and Prejudice');
  await page.locator('#form button[type="submit"]').click();
  await page.locator('[data-act="open-reader"]').click();
  await expect(page.locator('#chapter-reader')).toContainText('First chapter paragraph.');
  await page.locator('[data-act="close-reader"]').first().click();
  await expect(page.locator('#chapter-reader')).toBeHidden();
});
