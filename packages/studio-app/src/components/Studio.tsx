import * as React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Release from './Release';
import Releases from './Releases';
import StudioEditor from './StudioEditor';
import Home from './Home';

export interface EditorProps {
  basename: string;
}

export default function Editor({ basename }: EditorProps) {
  return (
    <BrowserRouter basename={basename}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/app/:appId/editor/*" element={<StudioEditor />} />
        <Route path="/app/:appId/releases" element={<Releases />} />
        <Route path="/app/:appId/releases/:version" element={<Release />} />
      </Routes>
    </BrowserRouter>
  );
}
