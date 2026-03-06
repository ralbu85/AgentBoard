# Contributing to TermHub

Thanks for your interest in improving TermHub.

## Before you start

- Open an issue first for large changes so we can align on scope.
- Keep pull requests focused and small when possible.

## Local setup

```bash
npm install
cp config.example.json config.json
echo -e "PORT=8081\nDASHBOARD_PASSWORD=yourpass" > .env
npm start
```

## Development guidelines

- Follow the existing code style and file structure.
- Avoid unrelated refactors in the same pull request.
- Update `README.md` and `README.ko.md` if behavior or setup changes.

## Commit and PR guidelines

- Use clear commit messages that explain what and why.
- Include a short PR description, testing notes, and screenshots for UI changes.
- Link related issues (for example: `Closes #12`).

## Testing

This project does not have an automated test suite yet.

- Validate core flows manually:
  - spawn a new session
  - attach an existing tmux session
  - switch Tab/Split layout
  - stop and remove workers
- Include your manual test steps in the PR description.

## Code of conduct

Be respectful and constructive in discussions and reviews.
