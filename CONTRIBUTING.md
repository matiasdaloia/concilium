# Contributing to Concilium

First off, thank you for considering contributing to Concilium! It's people like you that make this project better.

## Code of Conduct

This project and everyone participating in it is governed by our commitment to:
- Being respectful and inclusive
- Welcoming newcomers
- Focusing on constructive feedback
- Prioritizing user privacy and security

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check the existing issues to see if the problem has already been reported. When you are creating a bug report, please include as many details as possible:

- **Use a clear and descriptive title**
- **Describe the exact steps to reproduce the problem**
- **Provide specific examples to demonstrate the steps**
- **Describe the behavior you observed and what behavior you expected**
- **Include screenshots or screen recordings if applicable**
- **Include your environment details** (OS version, Concilium version, etc.)

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion, please include:

- **Use a clear and descriptive title**
- **Provide a step-by-step description of the suggested enhancement**
- **Provide specific examples to demonstrate the enhancement**
- **Explain why this enhancement would be useful**

### Pull Requests

1. Fork the repository
2. Create a new branch from `main` for your feature or bug fix
3. Make your changes
4. Ensure your code follows the existing style
5. Add or update tests as necessary
6. Update documentation as needed
7. Submit a pull request

## Development Setup

### Prerequisites

- Node.js 18+ 
- npm or yarn
- Git

### Desktop App

```bash
cd desktop
npm install
npm run start  # Start development server
```

### Website

```bash
cd website
npm install
npm run dev  # Start development server
```

## Project Structure

```
llm-council/
├── desktop/              # Electron application
│   ├── src/
│   │   ├── main/         # Main process (Node.js)
│   │   │   ├── services/ # Business logic
│   │   │   └── ipc.ts    # IPC handlers
│   │   ├── preload/      # Preload scripts
│   │   └── renderer/     # React frontend
│   │       ├── components/
│   │       ├── screens/
│   │       └── hooks/
│   └── package.json
├── website/              # Astro marketing site
│   ├── src/
│   │   ├── sections/
│   │   ├── islands/
│   │   └── layouts/
│   └── package.json
└── assets/               # Shared assets
```

## Style Guidelines

### TypeScript/JavaScript

- Use TypeScript for all new code
- Follow existing code style (enforced by ESLint)
- Use functional components with hooks for React
- Prefer explicit types over `any`

### CSS/Tailwind

- Use Tailwind CSS utility classes
- Follow the existing design system (colors in `tailwind.css`)
- Prefer semantic class names
- Use the custom color palette defined in the theme

### Git Commit Messages

- Use the present tense ("Add feature" not "Added feature")
- Use the imperative mood ("Move cursor to..." not "Moves cursor to...")
- Limit the first line to 72 characters or less
- Reference issues and pull requests liberally after the first line

Example:
```
Add support for custom juror models

- Allow users to specify which models to use for peer review
- Add configuration UI in settings
- Update pipeline to support dynamic juror selection

Fixes #123
```

## Testing

- Write tests for new features
- Run the test suite before submitting PRs:
  ```bash
  cd desktop
  npm run test
  ```
- Ensure all tests pass before submitting

## Documentation

- Update README.md if you change functionality
- Update CHANGELOG.md under the `[Unreleased]` section
- Add JSDoc comments for new functions and components
- Update type definitions in `types.ts` files

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

## Questions?

Feel free to open an issue for questions or join the discussions.

Thank you for contributing! 🎉
