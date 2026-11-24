import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildEditablePresentation } from '../src/lib/presentation';
import type { PresentationDeck } from '../src/lib/api';

const sampleDeck: PresentationDeck = {
  title: 'The Water Cycle',
  subtitle: 'How water moves through Earth systems',
  audience: 'Grade 8',
  slides: [
    { title: 'The Water Cycle', key_points: [], explanation: '', speaker_notes: 'Introduce the lesson.' },
    { title: 'Evaporation', key_points: ['Sunlight warms surface water', 'Liquid water becomes vapor', 'Water vapor rises into the air'], explanation: 'Heat supplies the energy for evaporation.', speaker_notes: 'Ask for examples of evaporation.' },
    { title: 'Review', key_points: ['Water changes state', 'Energy drives the cycle', 'The process repeats'], explanation: 'Connect each stage to the next.', speaker_notes: 'Invite learners to describe the cycle.' },
  ],
};

describe('editable PowerPoint export', () => {
  it('writes native slide text and shapes into pptx XML instead of flattening slides to images', async () => {
    const blob = await buildEditablePresentation(sampleDeck, 'ocean');
    expect(blob.size).toBeGreaterThan(1000);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const slide1 = await zip.file('ppt/slides/slide1.xml')!.async('text');
    const slide2 = await zip.file('ppt/slides/slide2.xml')!.async('text');
    const slide3 = await zip.file('ppt/slides/slide3.xml')!.async('text');
    expect(slide1).toContain('Editable presentation title');
    expect(slide1).toContain('The Water Cycle');
    expect(slide2).toContain('The Water Cycle');
    expect(slide3).toContain('Evaporation');
    expect(slide3).toContain('Sunlight warms surface water');
    expect(slide3).toContain('<p:sp>');
    expect(slide3).not.toContain('<p:pic>');
    const notes = await zip.file('ppt/notesSlides/notesSlide3.xml')!.async('text');
    expect(notes).toContain('Ask for examples of evaporation.');
  });

  it('keeps question-only explanations out of slide content and speaker notes', async () => {
    const blob = await buildEditablePresentation({
      ...sampleDeck,
      purpose: 'question-only',
      slides: [{
        title: 'Number Systems',
        key_points: ['Find five rational numbers between 3/4 and 4/5.'],
        explanation: 'Answer: 4/5 is greater.',
        speaker_notes: 'Give students time to attempt the question independently; do not reveal a solution.',
      }],
    });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const slide = await zip.file('ppt/slides/slide2.xml')!.async('text');
    const notes = await zip.file('ppt/notesSlides/notesSlide2.xml')!.async('text');
    expect(slide).toContain('Find five rational numbers between 3/4 and 4/5.');
    expect(slide).not.toContain('Answer: 4/5 is greater.');
    expect(notes).toContain('Give students time to attempt the question independently');
    expect(notes).not.toContain('Answer: 4/5 is greater.');
  });

  it('refuses to export a deck with no slides', async () => {
    await expect(buildEditablePresentation({ ...sampleDeck, slides: [] })).rejects.toThrow(/at least one slide/i);
  });
});
