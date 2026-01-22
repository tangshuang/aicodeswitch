import recommendMd from '../../../public/vendors-recommand.md?raw';
import readMeMd from '../../../README.md?raw';
import { useEffect, useState } from 'react';
import { api } from '../api/client';

function createDocHookFunc(markdown: string, apiFunc: Function) {
    let cacheRecommendMdPromise: Promise<any>;
    let cacheRecommendMd: string;

    const replaceImgSrc = (md: string) => {
        return md.replace(/!\[.*?\]\(.*?\)/g, (match) => {
            const src = match.match(/\((.*?)\)/)?.[1];
            if (src?.indexOf('public/') === 0) {
                const url = src.replace('public/', '/');
                return match.replace(src, url);
            }
            else {
                return match;
            }
        });
    }

    return function() {
        const [vendors, setVendors] = useState<string>(replaceImgSrc(markdown));

        useEffect(() => {
            if (cacheRecommendMd) {
                setVendors(replaceImgSrc(cacheRecommendMd));
                return;
            }

            const update = (result: string) => {
                if (!result) {
                    return;
                }
                cacheRecommendMd = result;
                setVendors(replaceImgSrc(result));
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