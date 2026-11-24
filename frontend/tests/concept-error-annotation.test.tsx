import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DualPaneReview from '../src/views/DualPaneReview';

const vm = {
  chips: [],
  awarded: 0,
  total: 2,
  pct: 0,
  grade: 'F',
  pass: false,
  qCount: 1,
  deducted: 2,
  mode: 'Standard',
  critCountText: '0 penalty criteria active',
  sub: 'One conceptual misconception found.',
  impact: [],
  contentExtra: 0,
  questions: [{
    no: 'Q2',
    questionText: 'Is 5x^3 + 2x - 7 a polynomial? Explain.',
    awarded: 0,
    total: 2,
    target: 'Yes. Negative constants and coefficients are allowed.',
    student: 'Constant is negative (-7)\nPolynomials should have only positive terms',
    tags: [],
    good: false,
    title: 'Marks deducted:',
    body: 'The claim that polynomials require positive terms is false.',
    page: 1,
    geometry: [
      { crop_id: 'p1c1', page: 1, rect: [0.2, 0.2, 0.3, 0.04], latex: 'Constant is negative (-7)' },
      { crop_id: 'p1c2', page: 1, rect: [0.2, 0.25, 0.4, 0.04], latex: 'Polynomials should have only positive terms' },
    ],
    steps: [{
      title: 'Check polynomial definition',
      status: 'correct',
      lines: [
        { crop_id: 'p1c1', text: 'Constant is negative (-7)', ok: true, error_tag: '' },
        { crop_id: 'p1c2', text: 'Polynomials should have only positive terms', ok: false, error_tag: '' },
      ],
      explanation: 'Conceptual misconception: negative constants are allowed; the positive-terms rule is false.',
    }],
  }],
  pageImages: ['data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='],
};

afterEach(() => cleanup());

describe('concept error review annotation', () => {
  it('shows a Concept Error callout linked to the incorrect claim', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    render(
      <DualPaneReview
        vm={vm}
        onUpdateQuestion={vi.fn()}
        onAcceptAll={vi.fn()}
      />,
    );

    const callout = screen.getAllByRole('button', { name: /Concept Error/ })[0];
    expect(callout).toHaveAttribute('title', expect.stringContaining('Polynomials should have only positive terms'));
    expect(screen.getAllByRole('button', { name: /Concept Error/ }).filter(button => button.hasAttribute('title')))
      .toHaveLength(1);
  });
});
