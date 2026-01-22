import recommendMd from '../../../docs/vendors-recommand.md?raw';
import readMeMd from '../../../README.md?raw';
import { useEffect, useState } from 'react';
import { api } from '../api/client';

function createDocHookFunc(markdown: string, apiFunc: Function) {
    let cacheRecommendMdPromise: Promise<any>;
    let cacheRecommendMd: string;

    return function() {
        const [vendors, setVendors] = useState<string>(markdown);

        useEffect(() => {
            if (cacheRecommendMd) {
                setVendors(cacheRecommendMd);
                return;
            }

            const update = (result: string) => {
                if (!result) {
                    return;
                }
                cacheRecommendMd = result;
                setVendors(result);
            };

            if (cacheRecommendMdPromise) {
                cacheRecommendMdPromise.then(update).catch(() => {});
            }
            else {
                cacheRecommendMdPromise = apiFunc().then(update).catch(() => {});
            }
        }, []);

        return vendors;
    }
}

export const useRecomandVendors = createDocHookFunc(recommendMd, api.getRecommendVendorsMarkdown);
export const useReadme = createDocHookFunc(readMeMd, api.getReadmeMarkdown);