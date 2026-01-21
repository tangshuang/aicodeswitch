import React from 'react';
import ReactMarkdown from 'react-markdown';
import usageContent from '../../README.md?raw';

const UsagePage: React.FC = () => {
  return (
    <div className="markdown-content">
      <ReactMarkdown>{usageContent}</ReactMarkdown>
    </div>
  );
};

export default UsagePage;
