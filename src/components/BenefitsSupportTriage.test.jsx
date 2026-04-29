import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mock the api module so component tests never touch the network.
vi.mock('../lib/api.js', () => ({
  listPosts: vi.fn(),
  categorizePost: vi.fn(),
  draftResponse: vi.fn(),
  getHealth: vi.fn(),
}));

import * as api from '../lib/api.js';
import BenefitsSupportTriage from './BenefitsSupportTriage.jsx';
import { SEED_POSTS } from '../data/seedPosts.js';
import { catById } from '../lib/categories.js';

// ---- Helpers ---------------------------------------------------------------

// The component fetches posts from /api/posts on mount. Build the same shape
// that the server returns from the static SEED_POSTS so we don't have to
// duplicate the test fixture.
function seedAsApiResponse() {
  return {
    posts: SEED_POSTS.map((p) => ({
      ...p,
      postedAt: p.posted, // mirror the API field name
      category: p.seedCategory ? catById(p.seedCategory).label : null,
      confidence: p.seedCategory ? 1 : null,
      reasoning: p.seedCategory ? 'Pre-categorized seed data' : null,
      draft: null,
    })),
  };
}

async function clickPostInList(user, title) {
  // Title appears in both list and detail when selected — the list
  // occurrence comes first in DOM order.
  const matches = screen.getAllByText(title);
  await user.click(matches[0]);
}

function expectDetailShowsPost(post) {
  return waitFor(() => {
    expect(screen.getByText(`posted by ${post.author}`)).toBeInTheDocument();
  });
}

// ---- Tests ----------------------------------------------------------------

describe('BenefitsSupportTriage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listPosts.mockResolvedValue(seedAsApiResponse());
  });

  describe('initial render', () => {
    it('shows a loading state then renders the header title', async () => {
      render(<BenefitsSupportTriage />);
      // Loading state appears first
      expect(screen.getByText(/Loading triage queue/)).toBeInTheDocument();

      await waitFor(() => {
        expect(screen.getByText(/Benefits Support/)).toBeInTheDocument();
      });
      expect(screen.getByText(/Triage Agent/)).toBeInTheDocument();
    });

    it('shows the correct queue stats', async () => {
      render(<BenefitsSupportTriage />);
      const total = SEED_POSTS.length;
      const answered = SEED_POSTS.filter((p) => p.status === 'answered').length;
      const open = total - answered;
      const uncategorized = SEED_POSTS.filter((p) => !p.seedCategory).length;

      await waitFor(() => screen.getByText('Total'));

      const totalBlock = screen.getByText('Total').closest('div');
      const openBlock = screen.getByText('Open').closest('div');
      const answeredBlock = screen.getByText('Answered').closest('div');
      const untriagedBlock = screen.getByText('Untriaged').closest('div');

      expect(within(totalBlock).getByText(String(total))).toBeInTheDocument();
      expect(within(openBlock).getByText(String(open))).toBeInTheDocument();
      expect(within(answeredBlock).getByText(String(answered))).toBeInTheDocument();
      expect(within(untriagedBlock).getByText(String(uncategorized))).toBeInTheDocument();
    });

    it('renders every seed post in the list', async () => {
      render(<BenefitsSupportTriage />);
      await waitFor(() => screen.getAllByText(SEED_POSTS[0].title));
      for (const p of SEED_POSTS) {
        expect(screen.getAllByText(p.title).length).toBeGreaterThanOrEqual(1);
      }
    });

    it('selects the first post by default', async () => {
      render(<BenefitsSupportTriage />);
      await expectDetailShowsPost(SEED_POSTS[0]);
    });

    it('shows a labeled "Categorize N new" button matching the uncategorized count', async () => {
      render(<BenefitsSupportTriage />);
      const uncategorized = SEED_POSTS.filter((p) => !p.seedCategory).length;
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: new RegExp(`Categorize ${uncategorized} new`) })
        ).toBeInTheDocument();
      });
    });
  });

  describe('API failure fallback', () => {
    it('falls back to seed data and shows a banner when /api/posts fails', async () => {
      api.listPosts.mockRejectedValue(new Error('connection refused'));
      render(<BenefitsSupportTriage />);

      await waitFor(() => {
        expect(screen.getByText(/connection refused/)).toBeInTheDocument();
      });
      // Should still render the seed posts
      expect(screen.getAllByText(SEED_POSTS[0].title).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('filtering', () => {
    it('filters by status: open updates the post-list count', async () => {
      const user = userEvent.setup();
      render(<BenefitsSupportTriage />);
      await waitFor(() => screen.getAllByText(SEED_POSTS[0].title));

      const openCount = SEED_POSTS.filter((p) => p.status === 'open').length;
      await user.click(screen.getByRole('button', { name: 'open' }));

      expect(screen.getByText(`${openCount} posts`)).toBeInTheDocument();
    });

    it('filters to "open" and hides answered post titles', async () => {
      const user = userEvent.setup();
      render(<BenefitsSupportTriage />);
      await waitFor(() => screen.getAllByText(SEED_POSTS[0].title));

      const otherAnswered = SEED_POSTS.find(
        (p) => p.status === 'answered' && p.id !== SEED_POSTS[0].id
      );
      await user.click(screen.getByRole('button', { name: 'open' }));
      expect(screen.queryByText(otherAnswered.title)).not.toBeInTheDocument();
    });

    it('filters to just uncategorized posts', async () => {
      const user = userEvent.setup();
      render(<BenefitsSupportTriage />);
      await waitFor(() => screen.getAllByText(SEED_POSTS[0].title));

      const uncategorizedCount = SEED_POSTS.filter((p) => !p.seedCategory).length;
      await user.click(screen.getByRole('button', { name: /Uncategorized/ }));

      expect(screen.getByText(`${uncategorizedCount} posts`)).toBeInTheDocument();
    });
  });

  describe('post selection', () => {
    it('updates the detail pane when a different post is clicked', async () => {
      const user = userEvent.setup();
      render(<BenefitsSupportTriage />);
      await waitFor(() => screen.getAllByText(SEED_POSTS[0].title));

      const second = SEED_POSTS[1];
      await clickPostInList(user, second.title);
      await expectDetailShowsPost(second);
    });
  });

  describe('answered post detail', () => {
    it('shows the resolved response for an answered post', async () => {
      const user = userEvent.setup();
      render(<BenefitsSupportTriage />);
      await waitFor(() => screen.getAllByText(SEED_POSTS[0].title));

      const answered = SEED_POSTS.find(
        (p) => p.status === 'answered' && p.id !== SEED_POSTS[0].id
      );
      await clickPostInList(user, answered.title);

      expect(await screen.findByText('Resolved response')).toBeInTheDocument();
      expect(screen.getByText(answered.answer)).toBeInTheDocument();
      expect(screen.getByText(answered.answeredBy)).toBeInTheDocument();
    });
  });

  describe('open post — generate draft', () => {
    it('shows the "Generate draft response" button for open posts', async () => {
      const user = userEvent.setup();
      render(<BenefitsSupportTriage />);
      await waitFor(() => screen.getAllByText(SEED_POSTS[0].title));

      const open = SEED_POSTS.find((p) => p.status === 'open');
      await clickPostInList(user, open.title);

      expect(
        await screen.findByRole('button', { name: /Generate draft response/i })
      ).toBeInTheDocument();
    });

    it('calls draftResponse with postId and renders the returned draft', async () => {
      const user = userEvent.setup();
      api.draftResponse.mockResolvedValue({ draft: 'Try the Variable Rate Profile setup.' });

      render(<BenefitsSupportTriage />);
      await waitFor(() => screen.getAllByText(SEED_POSTS[0].title));

      const open = SEED_POSTS.find((p) => p.status === 'open');
      await clickPostInList(user, open.title);
      await user.click(
        await screen.findByRole('button', { name: /Generate draft response/i })
      );

      await waitFor(() => {
        expect(screen.getByText('Try the Variable Rate Profile setup.')).toBeInTheDocument();
      });
      expect(api.draftResponse).toHaveBeenCalledWith({
        postId: open.id,
        title: open.title,
        body: open.body,
      });
    });

    it('surfaces an error banner if the draft API fails', async () => {
      const user = userEvent.setup();
      api.draftResponse.mockRejectedValue(new Error('network down'));

      render(<BenefitsSupportTriage />);
      await waitFor(() => screen.getAllByText(SEED_POSTS[0].title));

      const open = SEED_POSTS.find((p) => p.status === 'open');
      await clickPostInList(user, open.title);
      await user.click(
        await screen.findByRole('button', { name: /Generate draft response/i })
      );

      await waitFor(() => {
        expect(screen.getByText(/network down/)).toBeInTheDocument();
      });
    });
  });

  describe('batch categorization', () => {
    it('calls categorizePost with postId for every uncategorized post', async () => {
      const user = userEvent.setup();
      api.categorizePost.mockResolvedValue({
        category: 'Life Events',
        confidence: 0.85,
        reasoning: 'Mocked',
      });

      render(<BenefitsSupportTriage />);
      const uncategorizedCount = SEED_POSTS.filter((p) => !p.seedCategory).length;

      const button = await screen.findByRole('button', {
        name: new RegExp(`Categorize ${uncategorizedCount} new`),
      });
      await user.click(button);

      await waitFor(() => {
        expect(api.categorizePost).toHaveBeenCalledTimes(uncategorizedCount);
      });

      // Each call must include a postId
      for (const call of api.categorizePost.mock.calls) {
        expect(call[0].postId).toBeTruthy();
        expect(call[0].title).toBeTruthy();
        expect(call[0].body).toBeTruthy();
      }

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /All categorized/i })).toBeInTheDocument();
      });
    });

    it('rejects categories that are not in the taxonomy and leaves the post uncategorized', async () => {
      const user = userEvent.setup();
      api.categorizePost.mockResolvedValue({
        category: 'Bogus Category',
        confidence: 0.99,
        reasoning: 'invalid',
      });

      render(<BenefitsSupportTriage />);
      const uncategorizedCount = SEED_POSTS.filter((p) => !p.seedCategory).length;

      const button = await screen.findByRole('button', {
        name: new RegExp(`Categorize ${uncategorizedCount} new`),
      });
      await user.click(button);

      await waitFor(() => {
        expect(api.categorizePost).toHaveBeenCalled();
      });

      const untriagedBlock = screen.getByText('Untriaged').closest('div');
      expect(within(untriagedBlock).getByText(String(uncategorizedCount))).toBeInTheDocument();
    });
  });
});
