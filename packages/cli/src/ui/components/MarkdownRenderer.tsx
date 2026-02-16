import React from 'react';
import { Text } from 'ink';

interface MarkdownRendererProps {
  content: string;
}

/**
 * Simple markdown renderer for terminal output.
 * For full rendering, use marked + marked-terminal at the CLI level.
 */
export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return <Text>{content}</Text>;
}
