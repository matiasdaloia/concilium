import { memo } from 'react';
import { Streamdown } from 'streamdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface MarkdownRendererProps {
  content: string;
  className?: string;
  streaming?: boolean;
}

// Hoist stable references outside the component so React.memo can skip re-renders
const plugins = [remarkGfm];

const markdownComponents = {
  code({ className: codeClassName, children, ...props }: React.HTMLAttributes<HTMLElement> & { node?: unknown }) {
    const match = /language-(\w+)/.exec(codeClassName || '');
    const isInline = !match;
    if (isInline) {
      return (
        <code className="bg-bg-surface px-1.5 py-0.5 rounded text-green-primary text-xs" {...props}>
          {children}
        </code>
      );
    }
    return (
      <SyntaxHighlighter
        style={oneDark}
        language={match[1]}
        PreTag="div"
        customStyle={{ background: '#171717', borderRadius: '6px', fontSize: '12px', margin: '8px 0' }}
      >
        {String(children).replace(/\n$/, '')}
      </SyntaxHighlighter>
    );
  },
  table({ children }: { children?: React.ReactNode }) {
    return (
      <div className="overflow-x-auto my-3">
        <table className="border-collapse border border-border-secondary text-xs w-full">
          {children}
        </table>
      </div>
    );
  },
  th({ children }: { children?: React.ReactNode }) {
    return <th className="border border-border-secondary px-3 py-1.5 bg-bg-surface text-left text-text-secondary font-medium">{children}</th>;
  },
  td({ children }: { children?: React.ReactNode }) {
    return <td className="border border-border-secondary px-3 py-1.5 text-text-primary">{children}</td>;
  },
  h1({ children }: { children?: React.ReactNode }) { return <h1 className="text-lg font-semibold text-text-primary mt-4 mb-2">{children}</h1>; },
  h2({ children }: { children?: React.ReactNode }) { return <h2 className="text-base font-semibold text-text-primary mt-3 mb-2">{children}</h2>; },
  h3({ children }: { children?: React.ReactNode }) { return <h3 className="text-sm font-semibold text-text-primary mt-3 mb-1">{children}</h3>; },
  p({ children }: { children?: React.ReactNode }) { return <p className="text-text-primary text-xs leading-relaxed mb-2">{children}</p>; },
  ul({ children }: { children?: React.ReactNode }) { return <ul className="list-disc list-inside text-xs text-text-primary mb-2 space-y-0.5">{children}</ul>; },
  ol({ children }: { children?: React.ReactNode }) { return <ol className="list-decimal list-inside text-xs text-text-primary mb-2 space-y-0.5">{children}</ol>; },
  blockquote({ children }: { children?: React.ReactNode }) {
    return <blockquote className="border-l-2 border-green-primary pl-3 text-text-secondary italic my-2">{children}</blockquote>;
  },
};

export default memo(function MarkdownRenderer({ content, className = '', streaming = false }: MarkdownRendererProps) {
  const mode = streaming ? 'streaming' : 'static';

  return (
    <div className={`markdown-content prose prose-invert prose-sm max-w-none ${className}`}>
      <Streamdown
        mode={mode}
        remarkPlugins={plugins}
        components={markdownComponents}
      >
        {content}
      </Streamdown>
    </div>
  );
});
