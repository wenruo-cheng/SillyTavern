import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import storage from 'node-persist';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { setConfigFilePath } from '../src/util.js';

let diskCache;
let deleteCharacter;
let testRoot;
let directories;
let previousDataRoot;

beforeAll(async () => {
    setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));
    testRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sillytavern-characters-'));
    previousDataRoot = global.DATA_ROOT;
    global.DATA_ROOT = testRoot;
    const endpoint = await import('../src/endpoints/characters.js');
    diskCache = endpoint.diskCache;
    deleteCharacter = endpoint.router.stack.find(layer => layer.route?.path === '/delete').route.stack.at(-1).handle;
});

beforeEach(async () => {
    directories = {
        characters: path.join(testRoot, 'characters'),
        chats: path.join(testRoot, 'chats'),
        thumbnailsAvatar: path.join(testRoot, 'thumbnails'),
    };
    await Promise.all(Object.values(directories).map(dir => fs.promises.mkdir(dir, { recursive: true })));
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
    jest.restoreAllMocks();
    diskCache.dispose();
    await Promise.all(Object.values(directories).map(dir => fs.promises.rm(dir, { recursive: true, force: true })));
});

afterAll(async () => {
    if (previousDataRoot === undefined) {
        delete global.DATA_ROOT;
    } else {
        global.DATA_ROOT = previousDataRoot;
    }
    await fs.promises.rm(testRoot, { recursive: true, force: true });
});

async function deleteCard(deleteChats = false) {
    const response = { sendStatus: jest.fn(status => status) };
    await deleteCharacter({
        body: { avatar_url: 'card.png', delete_chats: deleteChats },
        user: { directories },
    }, response);
    expect(response.sendStatus).toHaveBeenCalledTimes(1);
    return response.sendStatus.mock.calls[0][0];
}

describe('character deletion', () => {
    test('deletes the card, thumbnail and requested chats', async () => {
        await fs.promises.writeFile(path.join(directories.characters, 'card.png'), 'card');
        await fs.promises.writeFile(path.join(directories.thumbnailsAvatar, 'card.png'), 'thumbnail');
        await fs.promises.mkdir(path.join(directories.chats, 'card'));
        await fs.promises.writeFile(path.join(directories.chats, 'card', 'chat.jsonl'), 'chat');

        expect(await deleteCard(true)).toBe(200);
        expect(fs.existsSync(path.join(directories.characters, 'card.png'))).toBe(false);
        expect(fs.existsSync(path.join(directories.thumbnailsAvatar, 'card.png'))).toBe(false);
        expect(fs.existsSync(path.join(directories.chats, 'card'))).toBe(false);
    });

    test('preserves chats when chat deletion is not requested', async () => {
        await fs.promises.writeFile(path.join(directories.characters, 'card.png'), 'card');
        await fs.promises.mkdir(path.join(directories.chats, 'card'));
        await fs.promises.writeFile(path.join(directories.chats, 'card', 'chat.jsonl'), 'chat');

        expect(await deleteCard()).toBe(200);
        expect(fs.readFileSync(path.join(directories.chats, 'card', 'chat.jsonl'), 'utf8')).toBe('chat');
    });

    test('returns 400 for a missing card without rejecting the request', async () => {
        expect(await deleteCard()).toBe(400);
    });

    test('handles two requests deleting the same card concurrently', async () => {
        await fs.promises.writeFile(path.join(directories.characters, 'card.png'), 'card');
        const unlink = fs.promises.unlink.bind(fs.promises);
        let release;
        const ready = new Promise(resolve => { release = resolve; });
        let finishDeletion;
        const deleted = new Promise(resolve => { finishDeletion = resolve; });
        let callers = 0;
        jest.spyOn(fs.promises, 'unlink').mockImplementation(async file => {
            const first = ++callers === 1;
            if (!first) release();
            await ready;
            if (!first) {
                await deleted;
                return unlink(file);
            }
            try {
                return await unlink(file);
            } finally {
                finishDeletion();
            }
        });

        const statuses = await Promise.all([deleteCard(), deleteCard()]);
        expect(statuses.sort()).toEqual([200, 400]);
    });

    for (const code of ['EACCES', 'EPERM']) {
        test(`returns 500 when unlink fails with ${code}`, async () => {
            await fs.promises.writeFile(path.join(directories.characters, 'card.png'), 'card');
            const error = Object.assign(new Error('Cannot delete card'), { code });
            jest.spyOn(fs.promises, 'unlink').mockRejectedValueOnce(error);

            expect(await deleteCard()).toBe(500);
            expect(fs.existsSync(path.join(directories.characters, 'card.png'))).toBe(true);
        });
    }

    test('returns 500 when thumbnail cleanup fails', async () => {
        await fs.promises.writeFile(path.join(directories.characters, 'card.png'), 'card');
        await fs.promises.writeFile(path.join(directories.thumbnailsAvatar, 'card.png'), 'thumbnail');
        jest.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => { throw new Error('Cannot delete thumbnail'); });

        expect(await deleteCard()).toBe(500);
    });

    test('returns 500 when chat cleanup fails', async () => {
        await fs.promises.writeFile(path.join(directories.characters, 'card.png'), 'card');
        jest.spyOn(fs.promises, 'rm').mockRejectedValueOnce(new Error('Cannot delete chats'));

        expect(await deleteCard(true)).toBe(500);
    });
});

describe('character disk cache', () => {
    test('shares initialization and retries after a shared failure', async () => {
        const error = new Error('Temporary cache initialization failure');
        let rejectInitialization;
        const failingInstance = {
            init: jest.fn(() => new Promise((resolve, reject) => { rejectInitialization = reject; })),
        };
        let completeInitialization;
        const workingInstance = {
            init: jest.fn(() => new Promise(resolve => { completeInitialization = resolve; })),
        };
        const create = jest.spyOn(storage, 'create')
            .mockReturnValueOnce(failingInstance)
            .mockReturnValueOnce(workingInstance);

        const failedReads = Promise.allSettled([diskCache.instance(), diskCache.instance()]);
        expect(create).toHaveBeenCalledTimes(1);
        expect(failingInstance.init).toHaveBeenCalledTimes(1);
        rejectInitialization(error);
        expect(await failedReads).toEqual([
            { status: 'rejected', reason: error },
            { status: 'rejected', reason: error },
        ]);

        const retriedReads = Promise.all([diskCache.instance(), diskCache.instance()]);
        expect(create).toHaveBeenCalledTimes(2);
        expect(workingInstance.init).toHaveBeenCalledTimes(1);
        completeInitialization();
        expect(await retriedReads).toEqual([workingInstance, workingInstance]);
        expect(await diskCache.instance()).toBe(workingInstance);
        expect(create).toHaveBeenCalledTimes(2);
    });
});
