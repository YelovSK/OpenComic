const kavita = require(p.join(appDir, '.dist/reading/sync/kavita.js'));

const providers = [
	kavita,
];

function find(path)
{
	if(!fileManager.isOpdsFile(path) || fileManager.serverInOfflineMode())
		return false;

	let url;

	try
	{
		url = opds.opds.downloadUrl(path);
	}
	catch
	{
		return false;
	}

	for(const provider of providers)
	{
		const book = provider.match(url);
		if(book) return {provider, book};
	}

	return false;
}

const pushed = new Map();

function push(path, page, pages)
{
	const target = find(path);
	if(!target) return;

	const value = page+'/'+pages;
	if(pushed.get(path) === value) return;

	pushed.set(path, value);

	target.provider.set(target.book, page, pages).catch(function(error) {

		pushed.delete(path);
		console.error(error);

	});
}

async function bookImages(path)
{
	if(fileManager.fileCompressed(path).getFeatures().ebook)
		return false;

	const file = fileManager.file(path);

	try
	{
		const files = fileManager.filtered(await file.read({filtered: false, sort: {extraKey: 'Reading'}}));

		// Books with nested folders would need per-folder progress, which a single remote page number can't describe
		if(!files.length || files.some((file) => file.folder || file.compressed))
			return false;

		return files;
	}
	finally
	{
		file.destroy();
	}
}

async function pull(path)
{
	const target = find(path);
	if(!target) return;

	try
	{
		const remote = await target.provider.get(target.book);
		if(!remote) return;

		const key = relative.path(path);
		const local = storage.getKey('readingProgress', key);

		if(local && local.lastReading >= remote.updated)
			return;

		const images = await bookImages(path);
		if(!images) return;

		const pages = images.length;
		const page = Math.min(remote.page, pages);

		pushed.set(path, page+'/'+pages);

		storage.setKey('readingProgress', key, {
			index: page,
			path: relative.path(images[page - 1].path),
			lastReading: remote.updated,
			ebook: false,
			progress: 0,
			chapterIndex: 0,
			chapterProgress: 0,
			page: page,
			pages: pages,
			percent: (pages === 1) ? 0 : (((page - 1) / (pages - 1)) * 100),
			completed: page >= pages,
		});
	}
	catch(error)
	{
		console.error(error);
	}
}

async function neighbour(path, direction)
{
	const target = find(path);
	if(!target) return false;

	try
	{
		const chapter = await target.provider.neighbour(target.book, direction);
		if(!chapter) return false;

		// Same naming as the catalog's own links, so the chapter keeps one path (and reading progress) however it's opened
		const name = opds.opds.base64(chapter.url)+p.extname(new URL(chapter.url).pathname);
		opds.addPathName(name, chapter.title);

		return serverClient.fixStart(p.join(p.dirname(path), name));
	}
	catch(error)
	{
		console.error(error);
		return false;
	}
}

module.exports = {
	push,
	pull,
	next: (path) => neighbour(path, 1),
	previous: (path) => neighbour(path, -1),
};
