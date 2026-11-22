import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { generateAnswerKeyPdf, generateExamPaperPdf } from '../src/lib/pdfGenerator';
import type { GeneratedExam } from '../src/lib/api';

const exam: GeneratedExam = {
  title: 'Edited Science Assessment',
  topic: 'Biology',
  instructions: 'Answer every question.',
  total_marks: 4,
  questions: [{
    number: 'Q1',
    text: 'Describe a plant cell.',
    max_marks: 4,
    expected_answer: 'A plant cell has a cell wall.',
    marking_scheme: 'Award marks for key structures.',
    keywords: ['cell wall'],
  }],
};

describe('custom exam PDF generation', () => {
  it('creates a valid printable PDF with the selected custom options', async () => {
    const withLines = await generateExamPaperPdf(exam, {
      includeAnswerLines: true,
      schoolName: 'Northfield School',
      gradeLevel: 'Grade 8',
      timeAllowed: '35 minutes',
    });
    const withoutLines = await generateExamPaperPdf(exam, {
      includeAnswerLines: false,
      schoolName: 'Northfield School',
      gradeLevel: 'Grade 8',
      timeAllowed: '35 minutes',
    });
    const parsed = await PDFDocument.load(withLines);
    expect(parsed.getPageCount()).toBe(1);
    expect(withLines.byteLength).toBeGreaterThan(500);
    expect(Array.from(withLines)).not.toEqual(Array.from(withoutLines));
  });

  it('creates a matching customized marking key PDF', async () => {
    const bytes = await generateAnswerKeyPdf(exam, { schoolName: 'Northfield School' });
    const parsed = await PDFDocument.load(bytes);
    expect(parsed.getPageCount()).toBe(1);
    expect(bytes.byteLength).toBeGreaterThan(500);
  });
});
