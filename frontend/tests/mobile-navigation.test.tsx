import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/components/PatternWaves.jsx', () => ({ default: () => null }));

import App from '../src/App';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

describe('phone navigation menu', () => {
  it('shows labeled touch targets for every section and closes after navigation', async () => {
    window.location.hash = '#notes';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, model: 'test-model', hasApiKey: false }),
    }) as unknown as Response));
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);

    render(<App />);
    const mobileNav = screen.getByRole('navigation', { name: 'Mobile main navigation' });
    fireEvent.click(within(mobileNav).getByRole('button', { name: 'Open navigation menu' }));

    const sections = within(mobileNav).getByRole('tablist', { name: 'App sections' });
    for (const label of ['Home', 'Exam Grading', 'Media Compressor', 'Generate Exam', 'Rubric Studio', 'Notes', 'Practice Questions', 'Analytics']) {
      expect(within(sections).getByRole('tab', { name: label })).toHaveClass('min-h-11');
    }
    expect(within(mobileNav).getByRole('button', { name: 'Start grading' })).toBeInTheDocument();

    const routes = [
      ['Home', 'home'],
      ['Exam Grading', 'grading'],
      ['Media Compressor', 'compressor'],
      ['Generate Exam', 'generator'],
      ['Rubric Studio', 'rubrics'],
      ['Notes', 'notes'],
      ['Practice Questions', 'practice'],
      ['Analytics', 'analytics'],
    ] as const;
    for (const [label, route] of routes) {
      fireEvent.click(within(within(mobileNav).getByRole('tablist', { name: 'App sections' })).getByRole('tab', { name: label }));
      expect(window.location.hash).toBe(`#${route}`);
      expect(screen.getByRole('main')).toBeInTheDocument();
      expect(within(mobileNav).getByRole('button', { name: 'Open navigation menu' })).toHaveAttribute('aria-expanded', 'false');
      if (route !== 'analytics') {
        fireEvent.click(within(mobileNav).getByRole('button', { name: 'Open navigation menu' }));
      }
    }
  });
});
