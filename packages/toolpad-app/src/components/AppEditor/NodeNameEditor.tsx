import { TextField } from '@mui/material';
import * as React from 'react';
import * as appDom from '../../appDom';
import { useDomApi } from '../DomLoader';

interface NodeNameEditorProps {
  node: appDom.AppDomNode;
}

export default function NodeNameEditor({ node }: NodeNameEditorProps) {
  const domApi = useDomApi();

  const [nameInput, setNameInput] = React.useState(node.name);
  React.useEffect(() => setNameInput(node.name), [node.name]);

  const handleNameInputChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => setNameInput(event.target.value),
    [],
  );

  const handleNameCommit = React.useCallback(
    () => domApi.setNodeName(node.id, nameInput),
    [domApi, node.id, nameInput],
  );

  const handleKeyPress = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Enter') {
        handleNameCommit();
      }
    },
    [handleNameCommit],
  );

  return (
    <TextField
      fullWidth
      size="small"
      label="name"
      value={nameInput}
      onChange={handleNameInputChange}
      onBlur={handleNameCommit}
      onKeyPress={handleKeyPress}
    />
  );
}
