import { NextApiRequest, NextApiResponse } from 'next';
import Cors from 'cors';
import { execApi, loadVersionedDom } from './data';
import initMiddleware from './initMiddleware';
import { NodeId, ApiResult, VersionOrPreview } from '../types';
import * as appDom from '../appDom';

// Initialize the cors middleware
const cors = initMiddleware<any>(
  // You can read more about the available options here: https://github.com/expressjs/cors#configuration-options
  Cors({
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
    // TODO: make this configurable
    origin: '*',
  }),
);

export interface HandleDataRequestParams {
  appId: string;
  version: VersionOrPreview;
}

export default async (
  req: NextApiRequest,
  res: NextApiResponse<ApiResult<any>>,
  { appId, version }: HandleDataRequestParams,
) => {
  await cors(req, res);
  const apiNodeId = req.query.queryId as NodeId;
  const dom = await loadVersionedDom(appId, version);
  const api = appDom.getNode(dom, apiNodeId, 'api');
  res.json(
    await execApi(appId, api, req.query.params ? JSON.parse(req.query.params as string) : {}),
  );
};
