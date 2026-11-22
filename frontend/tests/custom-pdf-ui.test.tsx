import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Generator from '../src/views/Generator';
import { generateExam } from '../src/lib/api';
import { downloadPdf, generateAnswerKeyPdf, generateExamPaperPdf } from '../src/lib/pdfGenerator';
import type { GeneratedExam } from '../src/lib/api';

vi.mock('../src/lib/api', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/api')>(),
  generateExam: vi.fn(),
}));
vi.mock('../src/lib/pdfGenerator', async importOriginal => ({
  ...await importOriginal<typeof import('../src/lib/pdfGenerator')>(),
  generateExamPaperPdf: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  generateAnswerKeyPdf: vi.fn().mockResolvedValue(new Uint8Array([4, 5, 6])),
  downloadPdf: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const generatedExam: GeneratedExam = {
  title: 'Biology Examination',
  topic: 'Biology',
  instructions: 'Answer all questions.',
  total_marks: 5,
  questions: [{
    number: 'Q1',
    text: 'Describe a plant cell.',
    max_marks: 5,
    expected_answer: 'It has a cell wall.',
    marking_scheme: 'Award points for the wall.',
    keywords: ['cell wall'],
  }],
};

beforeEach(() => {
  vi.mocked(generateExam).mockResolvedValue({ exam: structuredClone(generatedExam), model: 'test-model' });
  vi.mocked(generateExamPaperPdf).mockClear();
  vi.mocked(generateAnswerKeyPdf).mockClear();
  vi.mocked(downloadPdf).mockClear();
});

describe('custom PDF editor', () => {
  it('edits AI-generated exam fields and exports a customized paper and key', async () => {
    render(<Generator modelOverride="" setModelOverride={() => undefined} onSendToGrader={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Generate Exam with/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Customize & Edit PDF' }));

    fireEvent.change(screen.getByRole('textbox', { name: 'Custom PDF title' }), { target: { value: 'Grade 8 Cell Biology' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Question 1 text' }), { target: { value: 'Label the parts of a plant cell.' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Question 1 marks' }), { target: { value: '8' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Question 1 answer' }), { target: { value: 'Cell wall, membrane and nucleus.' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'School name' }), { target: { value: 'Northfield School' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Time allowed' }), { target: { value: '35 minutes' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include ruled answer lines under questions' }));

    fireEvent.click(screen.getByRole('button', { name: 'Generate Custom Question PDF' }));
    await waitFor(() => expect(generateExamPaperPdf).toHaveBeenCalledOnce());
    const [customExam, options] = vi.mocked(generateExamPaperPdf).mock.calls[0];
    expect(customExam.title).toBe('Grade 8 Cell Biology');
    expect(customExam.questions[0].text).toBe('Label the parts of a plant cell.');
    expect(customExam.questions[0].expected_answer).toBe('Cell wall, membrane and nucleus.');
    expect(customExam.questions[0].max_marks).toBe(8);
    expect(customExam.total_marks).toBe(8);
    expect(options).toMatchObject({ includeAnswerLines: false, timeAllowed: '35 minutes', schoolName: 'Northfield School' });

    fireEvent.click(screen.getByRole('button', { name: 'Generate Custom Answer Key PDF' }));
    await waitFor(() => expect(generateAnswerKeyPdf).toHaveBeenCalledOnce());
    expect(vi.mocked(generateAnswerKeyPdf).mock.calls[0][0].title).toBe('Grade 8 Cell Biology');
    expect(vi.mocked(generateAnswerKeyPdf).mock.calls[0][1]).toEqual({ schoolName: 'Northfield School' });
    expect(downloadPdf).toHaveBeenCalledTimes(2);
  });
});
