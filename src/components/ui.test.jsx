import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  CategoryChip,
  ConfidenceBar,
  StatusDot,
  Spinner,
  StatBlock,
  FilterRow,
} from './ui.jsx';

describe('CategoryChip', () => {
  it('renders the category label when known', () => {
    render(<CategoryChip label="Life Events" />);
    expect(screen.getByText('Life Events')).toBeInTheDocument();
  });

  it('falls back to an italic "uncategorized" pill on unknown labels', () => {
    render(<CategoryChip label="Made-up" />);
    const el = screen.getByText('uncategorized');
    expect(el).toBeInTheDocument();
    expect(el).toHaveClass('italic');
  });

  it('applies the dim modifier class when dim is true', () => {
    const { container } = render(<CategoryChip label="Life Events" dim />);
    const chip = container.firstChild;
    expect(chip.className).toMatch(/opacity-60/);
  });
});

describe('ConfidenceBar', () => {
  it('renders nothing when value is null', () => {
    const { container } = render(<ConfidenceBar value={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when value is undefined', () => {
    const { container } = render(<ConfidenceBar value={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a percentage rounded from a 0..1 number', () => {
    render(<ConfidenceBar value={0.876} />);
    expect(screen.getByText('88')).toBeInTheDocument();
  });

  it('exposes the percentage in the title attribute for accessibility', () => {
    const { container } = render(<ConfidenceBar value={0.5} />);
    expect(container.firstChild.getAttribute('title')).toBe('Confidence 50%');
  });
});

describe('StatusDot', () => {
  it('shows "answered" for answered status', () => {
    render(<StatusDot status="answered" />);
    expect(screen.getByText('answered')).toBeInTheDocument();
  });

  it('shows "open" for open status', () => {
    render(<StatusDot status="open" />);
    expect(screen.getByText('open')).toBeInTheDocument();
  });

  it('animates the dot only when open', () => {
    const { container, rerender } = render(<StatusDot status="open" />);
    // The first inner span is the colored dot
    const openDot = container.querySelector('span > span');
    expect(openDot.className).toMatch(/animate-pulse/);

    rerender(<StatusDot status="answered" />);
    const answeredDot = container.querySelector('span > span');
    expect(answeredDot.className).not.toMatch(/animate-pulse/);
  });
});

describe('Spinner', () => {
  it('renders an SVG with animate-spin', () => {
    const { container } = render(<Spinner />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg.classList.contains('animate-spin')).toBe(true);
  });
});

describe('StatBlock', () => {
  it('renders the label and value', () => {
    render(<StatBlock label="Open" value={5} />);
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('applies the accent color ring when accent is provided', () => {
    const { container } = render(<StatBlock label="X" value={1} accent="amber" />);
    expect(container.firstChild.className).toMatch(/ring-amber-500/);
  });
});

describe('FilterRow', () => {
  it('renders label and count', () => {
    render(<FilterRow active={false} onClick={() => {}} label="Life Events" count={3} />);
    expect(screen.getByText('Life Events')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('shows a swatch dot when a category is provided', () => {
    const cat = { id: 'life-events', label: 'Life Events', tint: '', swatch: '#fbbf24' };
    const { container } = render(
      <FilterRow active={false} onClick={() => {}} label="Life Events" count={3} category={cat} />
    );
    const swatch = container.querySelector('span > span');
    // happy-dom preserves the inline hex; jsdom normalizes to rgb().
    // Check the underlying style attribute string for portability.
    expect(swatch.getAttribute('style')).toMatch(/#fbbf24/i);
  });

  it('fires onClick when clicked', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const onClick = vi.fn();
    render(<FilterRow active={false} onClick={onClick} label="X" count={0} />);
    await userEvent.setup().click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
