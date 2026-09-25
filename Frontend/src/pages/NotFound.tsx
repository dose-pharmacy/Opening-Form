import React from 'react';
import { Link } from 'react-router-dom';
import { Home } from 'lucide-react';

const NotFound: React.FC = () => {
  return (
    <div className="min-h-screen bg-canvas flex flex-col items-center justify-center p-6 text-center">
      <h1 className="text-6xl font-serif font-bold text-accent mb-4">404</h1>
      <p className="text-xl text-text-secondary mb-8">The page you're looking for doesn't exist.</p>
      <Link 
        to="/" 
        className="flex items-center gap-2 bg-accent text-white px-6 py-3 rounded-lg font-medium hover:bg-accent-soft transition-all shadow-md"
      >
        <Home className="w-5 h-5" />
        Back to Workspace
      </Link>
    </div>
  );
};

export default NotFound;