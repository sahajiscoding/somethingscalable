import pptxgen from 'pptxgenjs';
import type { PresentationDeck, PresentationSlide } from './api';

export const PRESENTATION_THEMES = {
  emerald: { accent: '2F855A', pale: 'E8F5EC', ink: '17211B', muted: '53635A' },
  ocean: { accent: '2563EB', pale: 'EAF2FF', ink: '18243A', muted: '53647C' },
  violet: { accent: '7C3AED', pale: 'F2ECFF', ink: '261C3B', muted: '665A7A' },
  charcoal: { accent: '334155', pale: 'F1F5F9', ink: '1E293B', muted: '64748B' },
} as const;

export type PresentationTheme = keyof typeof PRESENTATION_THEMES;

export function createBlankSlide(number: number): PresentationSlide {
  return {
    title: `New slide ${number}`,
    key_points: [],
    explanation: '',
    speaker_notes: '',
  };
}

export async function buildEditablePresentation(
  deck: PresentationDeck,
  theme: PresentationTheme = 'emerald',
): Promise<Blob> {
  if (!deck.title.trim() || deck.slides.length < 1) throw new Error('Add a title and at least one slide before exporting.');
  const colors = PRESENTATION_THEMES[theme];
  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'WeHelpTeachers';
  pptx.subject = deck.subtitle || deck.audience;
  pptx.title = deck.title;
  pptx.company = 'WeHelpTeachers';
  pptx.theme = { headFontFace: 'Aptos Display', bodyFontFace: 'Aptos' };
  const slideCount = deck.slides.length + 1;

  // A separate native-object title slide; every model-generated lesson slide is
  // retained as content below, so none of the instructional material is dropped.
  const cover = pptx.addSlide();
  cover.background = { color: 'FFFFFF' };
  cover.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: 13.333, h: 0.24,
    line: { color: colors.accent, transparency: 100 },
    fill: { color: colors.accent },
  });
  cover.addText(deck.title, {
    x: 0.8, y: 1.55, w: 11.7, h: 1.2,
    fontFace: 'Aptos Display', fontSize: 34, bold: true,
    color: colors.ink, breakLine: false, valign: 'middle', fit: 'shrink',
    margin: 0.03, objectName: 'Editable presentation title',
  });
  cover.addText(deck.subtitle, {
    x: 0.84, y: 2.9, w: 11.4, h: 0.8,
    fontFace: 'Aptos', fontSize: 20, color: colors.muted,
    margin: 0.03, objectName: 'Editable presentation subtitle',
  });
  cover.addShape(pptx.ShapeType.roundRect, {
    x: 0.84, y: 4.2, w: 5.9, h: 0.62, rectRadius: 0.12,
    line: { color: colors.pale, transparency: 100 },
    fill: { color: colors.pale },
  });
  cover.addText(deck.audience ? `Designed for ${deck.audience}` : 'Learning presentation', {
    x: 1.05, y: 4.37, w: 5.5, h: 0.24,
    fontFace: 'Aptos', fontSize: 13, bold: true,
    color: colors.accent, margin: 0,
    objectName: 'Editable audience label',
  });
  cover.addText(`1 / ${slideCount}`, {
    x: 11.6, y: 7.05, w: 0.92, h: 0.2,
    fontFace: 'Aptos', fontSize: 9, color: colors.muted,
    align: 'right', margin: 0, objectName: 'Editable slide number 1',
  });

  deck.slides.forEach((item, index) => {
    const pageNumber = index + 2;
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };
    slide.addShape(pptx.ShapeType.rect, {
      x: 0, y: 0, w: 13.333, h: 0.24,
      line: { color: colors.accent, transparency: 100 },
      fill: { color: colors.accent },
    });
    slide.addText(item.title, {
      x: 0.78, y: 0.62, w: 11.8, h: 0.68,
      fontFace: 'Aptos Display', fontSize: 26, bold: true,
      color: colors.ink, margin: 0.02, breakLine: false,
      objectName: `Slide ${pageNumber} title`,
    });
    slide.addShape(pptx.ShapeType.rect, {
      x: 0.82, y: 1.42, w: 0.72, h: 0.06,
      line: { color: colors.accent, transparency: 100 },
      fill: { color: colors.accent },
    });

    let y = 1.78;
    for (const [pointIndex, point] of item.key_points.entries()) {
      slide.addShape(pptx.ShapeType.ellipse, {
        x: 0.94, y: y + 0.12, w: 0.12, h: 0.12,
        line: { color: colors.accent, transparency: 100 },
        fill: { color: colors.accent },
        objectName: `Slide ${pageNumber} bullet ${pointIndex + 1} marker`,
      });
      slide.addText(point, {
        x: 1.26, y, w: 10.95, h: 0.54,
        fontFace: 'Aptos', fontSize: 19, color: colors.ink,
        valign: 'middle', margin: 0.02, breakLine: false, fit: 'shrink',
        objectName: `Slide ${pageNumber} editable key point ${pointIndex + 1}`,
      });
      y += 0.72;
    }

    if (item.explanation.trim()) {
      slide.addShape(pptx.ShapeType.roundRect, {
        x: 0.82, y: 5.52, w: 11.65, h: 0.86,
        rectRadius: 0.1,
        line: { color: colors.pale, transparency: 100 },
        fill: { color: colors.pale },
      });
      slide.addText(item.explanation, {
        x: 1.02, y: 5.7, w: 11.24, h: 0.46,
        fontFace: 'Aptos', fontSize: 12, color: colors.muted,
        valign: 'middle', margin: 0.02, fit: 'shrink',
        objectName: `Slide ${pageNumber} editable explanation`,
      });
    }

    slide.addText(`${pageNumber} / ${slideCount}`, {
      x: 11.6, y: 7.05, w: 0.92, h: 0.2,
      fontFace: 'Aptos', fontSize: 9, color: colors.muted,
      align: 'right', margin: 0,
      objectName: `Editable slide number ${pageNumber}`,
    });
    const notes = [item.speaker_notes.trim(), item.explanation.trim() ? `Teaching explanation: ${item.explanation.trim()}` : '']
      .filter(Boolean)
      .join('\n\n');
    if (notes) slide.addNotes(notes);
  });

  const output = await pptx.write({ outputType: 'blob', compression: true });
  if (!(output instanceof Blob)) throw new Error('PowerPoint export did not produce a downloadable file.');
  return output;
}

export function downloadPresentation(blob: Blob, title: string) {
  const safeName = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'lesson-presentation';
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${safeName}.pptx`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
