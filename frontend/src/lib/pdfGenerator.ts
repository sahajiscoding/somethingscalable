import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import type { GeneratedExam, LiveReport } from './api';

/**
 * Sanitize text to ensure compatibility with standard PDF fonts (WinAnsi / Latin-1 encoding).
 * Maps unicode math symbols, quotes, and punctuation to safe printable characters.
 */
function sanitize(text: string | null | undefined): string {
  if (!text) return '';
  return String(text)
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u2022\u25CF]/g, '*')
    .replace(/\u221A/g, 'sqrt')
    .replace(/\u00B2/g, '^2')
    .replace(/\u00B3/g, '^3')
    .replace(/\u00B1/g, '+/-')
    .replace(/\u00D7/g, 'x')
    .replace(/\u00F7/g, '/')
    .replace(/\u2264/g, '<=')
    .replace(/\u2265/g, '>=')
    .replace(/\u2260/g, '!=')
    .replace(/\u2248/g, '~=')
    .replace(/\u03C0/g, 'pi')
    .replace(/\u0394/g, 'Delta')
    .replace(/\u03B8/g, 'theta')
    .replace(/\u03BB/g, 'lambda')
    .replace(/\u03BC/g, 'mu')
    .replace(/[\u2192\u279C]/g, '->')
    .replace(/[\u2190]/g, '<-')
    .replace(/[^\x00-\x7F\xA0-\xFF]/g, ' ');
}

/**
 * Word-wraps text within a given maximum width using the PDF font's actual glyph widths.
 */
function wrapText(text: string, font: PDFFont, fontSize: number, maxWidth: number): string[] {
  const clean = sanitize(text);
  const paragraphs = clean.split('\n');
  const result: string[] = [];

  for (const para of paragraphs) {
    if (!para.trim()) {
      result.push('');
      continue;
    }
    const words = para.split(/\s+/);
    let currentLine = '';

    for (const word of words) {
      if (!word) continue;
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      if (font.widthOfTextAtSize(testLine, fontSize) <= maxWidth) {
        currentLine = testLine;
      } else {
        if (currentLine) {
          result.push(currentLine);
          currentLine = word;
        } else {
          // Word longer than width — split character by character
          let sub = '';
          for (const ch of word) {
            if (font.widthOfTextAtSize(sub + ch, fontSize) <= maxWidth) {
              sub += ch;
            } else {
              result.push(sub);
              sub = ch;
            }
          }
          currentLine = sub;
        }
      }
    }
    if (currentLine) {
      result.push(currentLine);
    }
  }

  return result;
}

// Standard A4 dimensions in points (72 points/inch)
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN_LEFT = 45;
const MARGIN_RIGHT = 45;
const MARGIN_TOP = 48;
const MARGIN_BOTTOM = 48;
const CONTENT_W = PAGE_W - MARGIN_LEFT - MARGIN_RIGHT;

const COLOR_TEXT = rgb(0.12, 0.14, 0.17);
const COLOR_MUTED = rgb(0.42, 0.46, 0.52);
const COLOR_ACCENT = rgb(0.15, 0.45, 0.28);
const COLOR_BORDER = rgb(0.82, 0.85, 0.88);
const COLOR_BOX_BG = rgb(0.96, 0.97, 0.98);
const COLOR_RULE = rgb(0.88, 0.90, 0.92);

/**
 * Helper to manage drawing flow with automatic page splitting and footers.
 */
class FlowDocument {
  doc: PDFDocument;
  fontRegular!: PDFFont;
  fontBold!: PDFFont;
  fontItalic!: PDFFont;
  pages: PDFPage[] = [];
  currentPage!: PDFPage;
  y: number = PAGE_H - MARGIN_TOP;
  footerTitle: string;

  constructor(doc: PDFDocument, footerTitle: string) {
    this.doc = doc;
    this.footerTitle = footerTitle;
  }

  async init() {
    this.fontRegular = await this.doc.embedFont(StandardFonts.Helvetica);
    this.fontBold = await this.doc.embedFont(StandardFonts.HelveticaBold);
    this.fontItalic = await this.doc.embedFont(StandardFonts.HelveticaOblique);
    this.newPage();
  }

  newPage(): PDFPage {
    this.currentPage = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.currentPage);
    this.y = PAGE_H - MARGIN_TOP;
    return this.currentPage;
  }

  ensureSpace(neededHeight: number) {
    if (this.y - neededHeight < MARGIN_BOTTOM + 25) {
      this.newPage();
    }
  }

  drawText(
    text: string,
    font: PDFFont,
    size: number,
    color = COLOR_TEXT,
    alignRight = false,
    xOffset = 0,
  ) {
    const clean = sanitize(text);
    const width = font.widthOfTextAtSize(clean, size);
    const x = alignRight ? PAGE_W - MARGIN_RIGHT - width - xOffset : MARGIN_LEFT + xOffset;
    this.currentPage.drawText(clean, {
      x,
      y: this.y - size,
      size,
      font,
      color,
    });
  }

  drawParagraph(text: string, font: PDFFont, size: number, color = COLOR_TEXT, lineHeight = 1.35, indent = 0) {
    const lines = wrapText(text, font, size, CONTENT_W - indent);
    const step = size * lineHeight;
    for (const line of lines) {
      this.ensureSpace(step);
      this.drawText(line, font, size, color, false, indent);
      this.y -= step;
    }
  }

  applyFooters() {
    const total = this.pages.length;
    for (let i = 0; i < total; i++) {
      const p = this.pages[i];
      // Subtle top divider for footer
      p.drawLine({
        start: { x: MARGIN_LEFT, y: MARGIN_BOTTOM + 12 },
        end: { x: PAGE_W - MARGIN_RIGHT, y: MARGIN_BOTTOM + 12 },
        thickness: 0.5,
        color: COLOR_BORDER,
      });

      // Left footer
      p.drawText(sanitize(this.footerTitle), {
        x: MARGIN_LEFT,
        y: MARGIN_BOTTOM,
        size: 8.5,
        font: this.fontRegular,
        color: COLOR_MUTED,
      });

      // Right footer: Page X of Y
      const pageStr = `Page ${i + 1} of ${total}`;
      const pageW = this.fontRegular.widthOfTextAtSize(pageStr, 8.5);
      p.drawText(pageStr, {
        x: PAGE_W - MARGIN_RIGHT - pageW,
        y: MARGIN_BOTTOM,
        size: 8.5,
        font: this.fontRegular,
        color: COLOR_MUTED,
      });
    }
  }
}

/**
 * Generate a printable examination question paper in PDF format.
 */
export async function generateExamPaperPdf(
  exam: GeneratedExam,
  options: { includeAnswerLines?: boolean; gradeLevel?: string } = {},
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const flow = new FlowDocument(pdfDoc, 'WeHelpTeachers · Official Examination Paper');
  await flow.init();

  const includeLines = options.includeAnswerLines !== false;

  // -- Exam Header --
  flow.drawText('CONFIDENTIAL · EXAMINATION QUESTION PAPER', flow.fontBold, 8.5, COLOR_MUTED);
  flow.y -= 14;

  const titleLines = wrapText(exam.title || 'Examination Question Paper', flow.fontBold, 16, CONTENT_W);
  for (const t of titleLines) {
    flow.drawText(t, flow.fontBold, 16, COLOR_TEXT);
    flow.y -= 20;
  }

  if (exam.topic) {
    flow.drawText(`Subject / Curriculum: ${exam.topic}`, flow.fontBold, 10, COLOR_ACCENT);
    flow.y -= 14;
  }

  // Metadata ribbon
  const metaText = `Total Marks: ${exam.total_marks || 0}   |   Questions: ${exam.questions?.length || 0}   |   Time Allowed: 1 Hour`;
  flow.drawText(metaText, flow.fontRegular, 9.5, COLOR_MUTED);
  flow.y -= 12;

  // Candidate Details Box
  flow.ensureSpace(50);
  flow.currentPage.drawRectangle({
    x: MARGIN_LEFT,
    y: flow.y - 42,
    width: CONTENT_W,
    height: 42,
    color: COLOR_BOX_BG,
    borderColor: COLOR_BORDER,
    borderWidth: 0.8,
  });

  flow.currentPage.drawText('Candidate Name: _________________________________________', {
    x: MARGIN_LEFT + 12,
    y: flow.y - 18,
    size: 9,
    font: flow.fontRegular,
    color: COLOR_TEXT,
  });
  flow.currentPage.drawText('Roll No: ____________________', {
    x: MARGIN_LEFT + 345,
    y: flow.y - 18,
    size: 9,
    font: flow.fontRegular,
    color: COLOR_TEXT,
  });
  flow.currentPage.drawText('Date of Exam: ____________________', {
    x: MARGIN_LEFT + 12,
    y: flow.y - 34,
    size: 9,
    font: flow.fontRegular,
    color: COLOR_TEXT,
  });
  flow.currentPage.drawText('Invigilator Sign: ____________________', {
    x: MARGIN_LEFT + 345,
    y: flow.y - 34,
    size: 9,
    font: flow.fontRegular,
    color: COLOR_TEXT,
  });
  flow.y -= 54;

  // Instructions
  if (exam.instructions) {
    flow.ensureSpace(28);
    flow.drawText('INSTRUCTIONS TO CANDIDATES:', flow.fontBold, 9, COLOR_TEXT);
    flow.y -= 12;
    flow.drawParagraph(exam.instructions, flow.fontItalic, 8.5, COLOR_MUTED, 1.3);
    flow.y -= 8;
  }

  // Divider
  flow.currentPage.drawLine({
    start: { x: MARGIN_LEFT, y: flow.y },
    end: { x: PAGE_W - MARGIN_RIGHT, y: flow.y },
    thickness: 1,
    color: COLOR_BORDER,
  });
  flow.y -= 18;

  // -- Questions --
  (exam.questions || []).forEach((q, idx) => {
    flow.ensureSpace(70);

    // Question number & Marks badge
    const qNum = q.number || `Q${idx + 1}`;
    const marksStr = `[${q.max_marks || 0} Marks]`;

    flow.drawText(qNum, flow.fontBold, 11, COLOR_ACCENT);
    flow.drawText(marksStr, flow.fontBold, 10, COLOR_MUTED, true);
    flow.y -= 15;

    // Question body
    flow.drawParagraph(q.text || '', flow.fontRegular, 10, COLOR_TEXT, 1.4, 10);
    flow.y -= 6;

    // Ruled Answer Lines (for writing on physical printouts)
    if (includeLines) {
      const linesCount = Math.min(6, Math.max(3, Math.round((q.max_marks || 5) * 0.8)));
      flow.ensureSpace(linesCount * 14 + 10);
      for (let i = 0; i < linesCount; i++) {
        flow.y -= 14;
        flow.currentPage.drawLine({
          start: { x: MARGIN_LEFT + 12, y: flow.y },
          end: { x: PAGE_W - MARGIN_RIGHT - 12, y: flow.y },
          thickness: 0.5,
          color: COLOR_RULE,
        });
      }
      flow.y -= 10;
    }

    flow.y -= 12;
  });

  // End of examination notice
  flow.ensureSpace(30);
  const endNotice = '— END OF QUESTION PAPER —';
  const endW = flow.fontBold.widthOfTextAtSize(endNotice, 9);
  flow.currentPage.drawText(endNotice, {
    x: (PAGE_W - endW) / 2,
    y: flow.y - 12,
    size: 9,
    font: flow.fontBold,
    color: COLOR_MUTED,
  });

  flow.applyFooters();
  return await pdfDoc.save();
}

/**
 * Generate an official Marking Scheme & Rubric Key in PDF format.
 */
export async function generateAnswerKeyPdf(exam: GeneratedExam): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const flow = new FlowDocument(pdfDoc, 'WeHelpTeachers · Official Marking Rubric & Answer Key');
  await flow.init();

  // -- Header --
  flow.drawText('OFFICIAL EVALUATOR GUIDE · STRICTLY FOR EXAMINERS', flow.fontBold, 8.5, rgb(0.7, 0.2, 0.2));
  flow.y -= 14;

  const titleLines = wrapText(`${exam.title || 'Exam'} — Marking Rubric`, flow.fontBold, 15, CONTENT_W);
  for (const t of titleLines) {
    flow.drawText(t, flow.fontBold, 15, COLOR_TEXT);
    flow.y -= 18;
  }

  const meta = `Subject: ${exam.topic || 'General'}   |   Total Marks: ${exam.total_marks || 0}   |   ${exam.questions?.length || 0} Questions`;
  flow.drawText(meta, flow.fontRegular, 9.5, COLOR_MUTED);
  flow.y -= 14;

  // Divider
  flow.currentPage.drawLine({
    start: { x: MARGIN_LEFT, y: flow.y },
    end: { x: PAGE_W - MARGIN_RIGHT, y: flow.y },
    thickness: 1,
    color: COLOR_BORDER,
  });
  flow.y -= 18;

  // -- Questions & Solutions --
  (exam.questions || []).forEach((q, idx) => {
    flow.ensureSpace(90);

    const qNum = q.number || `Q${idx + 1}`;
    const marksStr = `[Max Marks: ${q.max_marks || 0}]`;

    // Question Header Box
    flow.drawText(`${qNum} — Official Solution & Marking Breakdown`, flow.fontBold, 11, COLOR_ACCENT);
    flow.drawText(marksStr, flow.fontBold, 9.5, COLOR_MUTED, true);
    flow.y -= 14;

    // Original Question snippet
    if (q.text) {
      flow.drawText('Question Text:', flow.fontBold, 8.5, COLOR_MUTED, false, 8);
      flow.y -= 10;
      flow.drawParagraph(q.text, flow.fontItalic, 8.5, COLOR_MUTED, 1.3, 8);
      flow.y -= 8;
    }

    // Target Answer
    flow.ensureSpace(30);
    flow.drawText('Model Target Answer:', flow.fontBold, 9, COLOR_TEXT, false, 8);
    flow.y -= 11;
    flow.drawParagraph(q.expected_answer || 'Complete target answer not provided.', flow.fontRegular, 9, COLOR_TEXT, 1.35, 12);
    flow.y -= 8;

    // Marking Scheme Steps
    if (q.marking_scheme) {
      flow.ensureSpace(30);
      flow.drawText('Step-by-Step Marking Breakdown:', flow.fontBold, 9, COLOR_ACCENT, false, 8);
      flow.y -= 11;
      flow.drawParagraph(q.marking_scheme, flow.fontRegular, 8.5, COLOR_TEXT, 1.35, 12);
      flow.y -= 6;
    }

    // Keywords checklist
    if (q.keywords && q.keywords.length > 0) {
      flow.ensureSpace(20);
      flow.drawText(`Required Keywords: ${q.keywords.join(', ')}`, flow.fontBold, 8.5, COLOR_MUTED, false, 8);
      flow.y -= 10;
    }

    // Question separator
    flow.y -= 6;
    flow.currentPage.drawLine({
      start: { x: MARGIN_LEFT, y: flow.y },
      end: { x: PAGE_W - MARGIN_RIGHT, y: flow.y },
      thickness: 0.5,
      color: COLOR_BORDER,
    });
    flow.y -= 16;
  });

  flow.applyFooters();
  return await pdfDoc.save();
}

/**
 * Generate a complete Grading Evaluation Report in PDF format.
 */
export async function generateGradingReportPdf(report: LiveReport): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const flow = new FlowDocument(pdfDoc, 'WeHelpTeachers · Exam Evaluation & Grading Report');
  await flow.init();

  const s = report.summary;
  const pct = s.total_marks ? ((s.marks_awarded / s.total_marks) * 100).toFixed(1) : '0.0';

  // -- Header --
  flow.drawText('OFFICIAL EVALUATION AUDIT REPORT', flow.fontBold, 8.5, COLOR_ACCENT);
  flow.y -= 14;

  flow.drawText('Automated Exam Grading & Feedback Report', flow.fontBold, 15, COLOR_TEXT);
  flow.y -= 16;

  const sub = `Model: ${report.model}   |   Engine: ${report.engine}   |   Checking Mode: ${report.mode.strict ? 'Strict' : 'Standard'}`;
  flow.drawText(sub, flow.fontRegular, 9, COLOR_MUTED);
  flow.y -= 16;

  // -- Score Overview Card --
  flow.ensureSpace(65);
  flow.currentPage.drawRectangle({
    x: MARGIN_LEFT,
    y: flow.y - 55,
    width: CONTENT_W,
    height: 55,
    color: COLOR_BOX_BG,
    borderColor: COLOR_BORDER,
    borderWidth: 0.8,
  });

  flow.currentPage.drawText('MARKS OBTAINED', {
    x: MARGIN_LEFT + 14,
    y: flow.y - 18,
    size: 8.5,
    font: flow.fontBold,
    color: COLOR_MUTED,
  });
  flow.currentPage.drawText(`${s.marks_awarded} / ${s.total_marks}`, {
    x: MARGIN_LEFT + 14,
    y: flow.y - 42,
    size: 20,
    font: flow.fontBold,
    color: COLOR_ACCENT,
  });

  flow.currentPage.drawText('PERCENTAGE', {
    x: MARGIN_LEFT + 190,
    y: flow.y - 18,
    size: 8.5,
    font: flow.fontBold,
    color: COLOR_MUTED,
  });
  flow.currentPage.drawText(`${pct}%`, {
    x: MARGIN_LEFT + 190,
    y: flow.y - 42,
    size: 20,
    font: flow.fontBold,
    color: COLOR_TEXT,
  });

  flow.currentPage.drawText('QUESTIONS GRADED', {
    x: MARGIN_LEFT + 340,
    y: flow.y - 18,
    size: 8.5,
    font: flow.fontBold,
    color: COLOR_MUTED,
  });
  flow.currentPage.drawText(`${s.questions_graded} Total`, {
    x: MARGIN_LEFT + 340,
    y: flow.y - 42,
    size: 16,
    font: flow.fontBold,
    color: COLOR_TEXT,
  });
  flow.y -= 70;

  // Deductions summary
  const byCat = s.deductions_by_category || {};
  const catKeys = Object.keys(byCat);
  if (catKeys.length > 0) {
    flow.ensureSpace(35);
    flow.drawText('Deductions by Category:', flow.fontBold, 9.5, COLOR_TEXT);
    flow.y -= 13;
    const catStr = catKeys.map(k => `${k}: -${byCat[k]} marks`).join('   |   ');
    flow.drawText(catStr, flow.fontRegular, 8.5, rgb(0.7, 0.2, 0.2));
    flow.y -= 16;
  }

  // Divider
  flow.currentPage.drawLine({
    start: { x: MARGIN_LEFT, y: flow.y },
    end: { x: PAGE_W - MARGIN_RIGHT, y: flow.y },
    thickness: 1,
    color: COLOR_BORDER,
  });
  flow.y -= 18;

  // -- Question Details --
  (report.questions || []).forEach(q => {
    flow.ensureSpace(80);

    const isGood = q.marks_deducted <= 0;
    const qTitle = `Q${q.number} — ${q.marks_awarded} / ${q.max_marks} Marks`;
    const cutStr = isGood ? 'Full Marks Awarded' : `Deducted: -${q.marks_deducted} Marks`;

    flow.drawText(qTitle, flow.fontBold, 10.5, isGood ? COLOR_ACCENT : COLOR_TEXT);
    flow.drawText(cutStr, flow.fontBold, 9, isGood ? COLOR_ACCENT : rgb(0.7, 0.2, 0.2), true);
    flow.y -= 14;

    // Expected vs Student
    flow.drawText('Target Key Answer:', flow.fontBold, 8.5, COLOR_MUTED, false, 8);
    flow.y -= 10;
    flow.drawParagraph(q.expected_answer || '—', flow.fontRegular, 8.5, COLOR_TEXT, 1.3, 8);
    flow.y -= 6;

    flow.drawText('Student Response:', flow.fontBold, 8.5, COLOR_MUTED, false, 8);
    flow.y -= 10;
    flow.drawParagraph(q.student_answer || '—', flow.fontRegular, 8.5, COLOR_TEXT, 1.3, 8);
    flow.y -= 8;

    // Evaluator explanation
    if (q.feedback) {
      flow.drawText('Examiner Feedback & Reasoning:', flow.fontBold, 8.5, COLOR_ACCENT, false, 8);
      flow.y -= 10;
      flow.drawParagraph(q.feedback, flow.fontRegular, 8.5, COLOR_TEXT, 1.3, 8);
      flow.y -= 8;
    }

    // Question border
    flow.currentPage.drawLine({
      start: { x: MARGIN_LEFT, y: flow.y },
      end: { x: PAGE_W - MARGIN_RIGHT, y: flow.y },
      thickness: 0.5,
      color: COLOR_BORDER,
    });
    flow.y -= 14;
  });

  flow.applyFooters();
  return await pdfDoc.save();
}

/**
 * Triggers a native browser file download for binary PDF data.
 */
export function downloadPdf(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 500);
}
