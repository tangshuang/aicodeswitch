import React from 'react';
import ReactMarkdown from 'react-markdown';
import { useReadme } from '../hooks/docs';

const UsagePage: React.FC = () => {
  const usageContent = useReadme();
  return (
    <div className="markdown-content">
      <ReactMarkdown>{usageContent}</ReactMarkdown>
    </div>
  );
};

export default UsagePage;
