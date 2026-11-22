import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dropzone } from '../src/views/Grading';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderUpload = (onFile = vi.fn()) => render(
  <Dropzone
    docKey="paper"
    title="Upload Question Paper"
    hint="Tap to choose a file"
    file={null}
    onFile={onFile}
    onClear={vi.fn()}
    missing={false}
    compressing={false}
    shrink={null}
    onCompress={vi.fn()}
  />,
);

describe('mobile-friendly grading uploads', () => {
  it('connects the visible upload area to the native file input', () => {
    renderUpload();
    const input = screen.getByLabelText('Choose Upload Question Paper file') as HTMLInputElement;
    const label = screen.getByText('Upload Question Paper').closest('label');
    expect(label?.htmlFor).toBe(input.id);
    fireEvent.click(label!);
    expect(input.accept).toContain('application/pdf');
    expect(input.accept).toContain('image/*');
  });

  it('passes selected files through and resets the input so the same file can be selected again', () => {
    const onFile = vi.fn();
    renderUpload(onFile);
    const input = screen.getByLabelText('Choose Upload Question Paper file') as HTMLInputElement;
    const first = new File(['paper'], 'paper.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [first] } });
    expect(onFile).toHaveBeenLastCalledWith('paper', first);
    expect(input.value).toBe('');

    const sameNameAgain = new File(['updated paper'], 'paper.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [sameNameAgain] } });
    expect(onFile).toHaveBeenCalledTimes(2);
    expect(onFile).toHaveBeenLastCalledWith('paper', sameNameAgain);
  });

  it('continues to accept drag-and-drop uploads on desktop', () => {
    const onFile = vi.fn();
    renderUpload(onFile);
    const file = new File(['answer sheet'], 'student.jpg', { type: 'image/jpeg' });
    const zone = screen.getByText('Upload Question Paper').closest('label')?.parentElement;
    fireEvent.drop(zone!, { dataTransfer: { files: [file] } });
    expect(onFile).toHaveBeenCalledWith('paper', file);
  });
});
