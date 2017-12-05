const nodegit = require('nodegit');
const path = require('path');
const fs = require('fs');
const JSONDatabase = require('./JSONDatabase');

/**
 * Módulo para obtenção dos dados do repositório.
 * @constructor
 */
function GitPipe() {
    this.nodegitRepository = null;
    this.db = null;
    this.diffs = [];
}

/**
 * Salva a base de dados em arquivo.
 * @return Caso tenha sucesso na escrita em arquivo retorna true,
 *  ou false caso contrário.
 */
GitPipe.prototype.save = function () {
    return this.db.saveToDisk();
};

/**
 * Cria registro do arquivo relacionado ao patch.
 * @param  {NodeGit.ConvenientPatch} patch - Objeto patch com os dados do arquivo.
 * @return {Promise} Um promise que retorna um JSONDatabase.FileRecord
 */
GitPipe.prototype.createFile = function (patch) {
    console.log('> createFile()');
    console.log('  patch:', patch);
    let newFileId = patch.newFile().id().toString();
    let newFilePath = patch.newFile().path();
    console.log('  newFilePath:', newFilePath);
    let oldFileId = patch.oldFile().id().toString();
    let oldFilePath = patch.oldFile().path();
    let patchStatus = null;
    if (oldFilePath != newFilePath) {
        patchStatus = JSONDatabase.FILESTATUS.MOVED;
    } else if (patch.isAdded()) {
        patchStatus = JSONDatabase.FILESTATUS.ADDED;
    } else if (patch.isDeleted()) {
        patchStatus = JSONDatabase.FILESTATUS.DELETED;
    } else if (patch.isModified()) {
        patchStatus = JSONDatabase.FILESTATUS.MODIFIED;
    } else {
        patchStatus = JSONDatabase.FILESTATUS.UNMODIFIED;
    }
    let statistic = new JSONDatabase.Statistic(0, 0, 0);
    let fileRec = new JSONDatabase.FileRecord();
    fileRec.id = newFileId;
    fileRec.name = path.basename(newFilePath);
    fileRec.path = newFilePath;
    fileRec.oldFileId = oldFileId;
    fileRec.status = patchStatus;
    fileRec.statistic = statistic;
    return patch.hunks().then((hunks) => {
        let hunkPromises = [];
        hunks.forEach((hunk) => {
            hunkPromises.push(hunk.lines());
        });
        return Promise.all(hunkPromises);
    }).then((listLines) => {
        listLines.forEach((lines) => {
            lines.forEach((line) => {
                let oldLineNum = line.oldLineno();
                let newLineNum = line.newLineno();
                let lineStatus = null;
                let sign = String.fromCharCode(line.origin()).trim();
                console.log('line:', line.content() + ' sign:', sign);
                if (sign.length > 0) {
                    if (sign === '-') {
                        lineStatus = JSONDatabase.LINESTATUS.DELETED;
                        fileRec.statistic.deleted++;
                    } else if (sign === '+') {
                        lineStatus = JSONDatabase.LINESTATUS.ADDED;
                        fileRec.statistic.added++;
                    }
                    let lineRec = new JSONDatabase.LineRecord();
                    lineRec.oldLineNum = oldLineNum;
                    lineRec.newLineNum = newLineNum;
                    lineRec.status = lineStatus;
                    fileRec.lines.push(lineRec);
                }
            });
        });
        console.log('< createFile()');
        return fileRec;
    });
};

/**
 * Cria registro de diretórios recursivamente (dos filhos à raiz).
 * @param {NodeGit.Commit} commit - Usado para a recuperação dos objetos tree à partir do seu caminho.
 * @param {String} dirPath - Caminho do diretório a ser criado/atualizado.
 * @param {JSONDatabase.EntryRecord} child - Filho do diretório a ser criado.
 * @return {JSONDatabase.EntryRecord} O último diretório criado (diretório raíz).
 */
GitPipe.prototype.createDirectory = function (commit, dirPath, child) {
    console.log('> createDirectory()');
    console.log('  dirPath:', dirPath);
    if (dirPath.length <= 0) {
        console.log('< createDirectory()');
        return null;
    } else if (dirPath === '.') {
        return commit.getTree().then((tree) => {
            let treeId = tree.id().toString();
            let foundDirRec = this.db.findDirectory(treeId);
            if (foundDirRec == undefined) { // Diretório ainda não existe
                let newDirRec = new JSONDatabase.DirectoryRecord();
                newDirRec.id = treeId;
                newDirRec.name = '';
                newDirRec.path = dirPath;
                newDirRec.statistic = new JSONDatabase.Statistic(0, 0, 0);
                if (child.type === JSONDatabase.ENTRYTYPE.FILE) {
                    if (child.status === JSONDatabase.FILESTATUS.ADDED) {
                        newDirRec.statistic.added++;
                    } else if (child.status === JSONDatabase.FILESTATUS.DELETED) {
                        newDirRec.statistic.deleted++;
                    } else if (child.status === JSONDatabase.FILESTATUS.MODIFIED) {
                        newDirRec.statistic.modified++;
                    }
                } else {
                    newDirRec.statistic.added += child.statistic.added;
                    newDirRec.statistic.deleted += child.statistic.deleted;
                    newDirRec.statistic.modified += child.statistic.modified;
                }
                newDirRec.entries.push(child.id);
                this.db.addDirectory(newDirRec);
                child = newDirRec;
            } else { // Diretório já criado, atualiza-o.
                if (child.type === JSONDatabase.ENTRYTYPE.FILE) {
                    if (child.status === JSONDatabase.FILESTATUS.ADDED) {
                        foundDirRec.statistic.added++;
                    } else if (child.status === JSONDatabase.FILESTATUS.DELETED) {
                        foundDirRec.statistic.deleted++;
                    } else if (child.status === JSONDatabase.FILESTATUS.MODIFIED) {
                        foundDirRec.statistic.modified++;
                    }
                } else {
                    foundDirRec.statistic.added += child.statistic.added;
                    foundDirRec.statistic.deleted += child.statistic.deleted;
                    foundDirRec.statistic.modified += child.statistic.modified;
                }
                foundDirRec.entries.push(child.id);
                child = foundDirRec;
            }
            console.log('< createDirectory()');
            return child;
        });
    } else {
        return commit.getEntry(dirPath).then((entry) => {
            console.assert(entry.isTree(), 'GitPipe#createDirectory: Error - Entry is not a tree.');
            return entry.getTree();
        }).then((tree) => {
            let treeId = tree.id().toString();
            let foundDirRec = this.db.findDirectory(treeId);
            if (foundDirRec == undefined) { // Diretório ainda não existe
                let newDirRec = new JSONDatabase.DirectoryRecord();
                newDirRec.id = treeId;
                newDirRec.name = path.basename(dirPath);
                newDirRec.path = dirPath;
                newDirRec.statistic = new JSONDatabase.Statistic(0, 0, 0);
                if (child.type === JSONDatabase.ENTRYTYPE.FILE) {
                    if (child.status === JSONDatabase.FILESTATUS.ADDED) {
                        newDirRec.statistic.added++;
                    } else if (child.status === JSONDatabase.FILESTATUS.DELETED) {
                        newDirRec.statistic.deleted++;
                    } else if (child.status === JSONDatabase.FILESTATUS.MODIFIED) {
                        newDirRec.statistic.modified++;
                    }
                } else {
                    newDirRec.statistic.added += child.statistic.added;
                    newDirRec.statistic.deleted += child.statistic.deleted;
                    newDirRec.statistic.modified += child.statistic.modified;
                }
                newDirRec.entries.push(child.id);
                this.db.addDirectory(newDirRec);
                child = newDirRec;
            } else { // Diretório já criado, atualiza-o.
                if (child.type === JSONDatabase.ENTRYTYPE.FILE) {
                    if (child.status === JSONDatabase.FILESTATUS.ADDED) {
                        foundDirRec.statistic.added++;
                    } else if (child.status === JSONDatabase.FILESTATUS.DELETED) {
                        foundDirRec.statistic.deleted++;
                    } else if (child.status === JSONDatabase.FILESTATUS.MODIFIED) {
                        foundDirRec.statistic.modified++;
                    }
                } else {
                    foundDirRec.statistic.added += child.statistic.added;
                    foundDirRec.statistic.deleted += child.statistic.deleted;
                    foundDirRec.statistic.modified += child.statistic.modified;
                }
                foundDirRec.entries.push(child.id);
                child = foundDirRec;
            }
            console.log('< createDirectory()');
            dirPath = path.dirname(dirPath);
            return this.createDirectory(commit, dirPath, child);
        });
    }
};

/**
 * Analisa o objeto patch e registra os diretórios e arquivos
 * com o estado de modificação.
 * @param {NodeGit.Commit} commit
 * @param {NodeGit.ConvenientPatch} patch
 * @param {Array<JSONDatabase.DirectoryRecord>} dirs
 */
GitPipe.prototype.parsePatch = function (commit, patch) {
    console.log('> parsePatch()');
    return this.createFile(patch).then((child) => {
        console.log('  child:', child);
        this.db.addFile(child);
        let dirPath = path.dirname(child.path).replace(/^(\.\/)?/, ''); // remove './' from begining.
        return this.createDirectory(commit, dirPath, child);
    }).then((v) => {
        console.log('< parsePatch()');
        return v;
    });
};

/**
 * Analisa cada objeto diff.
 * @param {NodeGit.Commit} commit - Objeto commit mais recente do diff.
 * @param {NodeGit.Diff} diff - Objeto com os dados do diff.
 */
GitPipe.prototype.parseDiff = function (commit, diff) {
    return diff.patches().then((patches) => {
        console.log('> parseDiff()');
        console.log('  diff:', diff);
        let parsePatchPromises = [];
        patches.forEach((patch) => {
            let prom = this.parsePatch(commit, patch);
            parsePatchPromises.push(prom);
        });
        return Promise.all(parsePatchPromises).then((dirRecs) => {
            let f = dirRecs.filter((d) => d.path === '.');
            console.assert(f.length === dirRecs.length, 'GitPipe#parseDiff: Error - Returned directories is not all root.');
            console.log('  parseDiff(): dirRecs:', dirRecs);
            console.log('< parseDiff()');
            return dirRecs[0];
        });
    });
};

/**
 * Analisa os diffs salvos temporariamente e insere na base de dados.
 */
GitPipe.prototype.parseDiffs = function () {
    console.log('> parseDiffs()');
    let patchesPromises = [];
    for (let i = 0; i < this.diffs.length; i++) {
        let diff = this.diffs[i];
        let prom1 = (function (self, diff) {
            let commitId = diff.diffRec.recentCommitId;
            return self.nodegitRepository.getCommit(commitId).then((commit) => {
                return self.parseDiff(commit, diff.gitDiff);
            }).then((dirRec) => {
                console.log('  parseDiffs(): dirRec:', dirRec);
                let dirId = dirRec.id;
                diff.diffRec.rootDirId = dirId;
                self.db.addDiff(diff.diffRec);
            }).then(() => {
                console.log('< parseDiffs()');
            });
        })(this, diff);
        patchesPromises.push(prom1);
    }
    this.diffs = [];
    return Promise.all(patchesPromises);
};

/**
 * Cria registro do diff com commits pai.
 * @param {JSONDatabase.CommitRecord} commitRec
 */
GitPipe.prototype.diffCommitWithParents = function (commitRec) {
    console.log('> diffCommitWithParents()');
    let commitId = commitRec.id;
    console.log('  commitId:', commitId);
    let commitSnapshotId = commitRec.snapshotId;
    console.log('  commitSnapshotId:', commitSnapshotId);
    let parentRec = null;
    let parentSnapshotId = null;
    let parentIds = commitRec.parents;
    console.log('  parentIds:', parentIds);
    let commitTree = null;
    return this.nodegitRepository.getTree(commitSnapshotId).then((tree1) => {
        commitTree = tree1;
        console.log('  commitTree:', commitTree);
        let createDiffPromises = [];
        parentIds.forEach((parentId) => {
            let foundDiff = this.diffs.find((diff) =>
                diff.diffRec.oldCommitId === parentId && diff.diffRec.recentCommitId === commitId);
            console.log('    foundDiff:', foundDiff);
            if (foundDiff == undefined) {
                parentRec = this.db.findCommit(parentId);
                parentSnapshotId = parentRec.snapshotId;
                diffRec = new JSONDatabase.DiffRecord();
                diffRec.oldCommitId = parentId;
                diffRec.recentCommitId = commitId;
                console.log('    diffRec:', diffRec);
                let prom = (function (self, diffRec, parentSnapshotId, commitTree) {
                    let parentTree;
                    return self.nodegitRepository.getTree(parentSnapshotId).then((tree2) => {
                        parentTree = tree2;
                        console.log('      parentTree:', parentTree);
                        return nodegit.Diff.treeToTree(self.nodegitRepository, parentTree, commitTree);
                    }).then((diff) => {
                        console.log('      diff:', diff);
                        self.diffs.push({
                            gitDiff: diff,
                            diffRec: diffRec
                        });
                    });
                })(this, diffRec, parentSnapshotId, commitTree);
                createDiffPromises.push(prom);
            }
        });
        return Promise.all(createDiffPromises);
    }).then(() => {
        console.log('< diffCommitWithParents()');
    });
};

/**
 * Percorre os commits e salva temporariamente
 * os diffs de cada commit com o commit pai.
 */
GitPipe.prototype.diffCommitsHistory = function () {
    let commitRecs = this.db.getCommits();
    let diffCommitsPromises = [];
    commitRecs.forEach((commitRec) => {
        let prom = this.diffCommitWithParents(commitRec);
        if (prom != null) {
            diffCommitsPromises.push(prom);
        }
    });
    return Promise.all(diffCommitsPromises);
};

/**
 * Cria registro do commit.
 * @param {NodeGit.Commit} commit - Commit a ser analisado.
 */
GitPipe.prototype.parseCommit = function (commit) {
    let commitRec = new JSONDatabase.CommitRecord(commit);
    let authorSign = commit.author();
    let authorRec = new JSONDatabase.AuthorRecord(authorSign);
    let authorEmail = authorRec.email;
    commitRec.authorEmail = authorEmail;
    this.db.addCommit(commitRec);
    this.db.addAuthor(authorRec);
    return commit.getParents().then((parents) => {
        let parseParentPromises = [];
        parents.forEach((parent) => {
            let prom = this.parseCommit(parent);
            if (prom != null) {
                parseParentPromises.push(prom);
            }
        });
        return Promise.all(parseParentPromises);
    });
};

/**
 * Percorre o histórico e analisa os commits.
 */
GitPipe.prototype.parseCommitsHistory = function () {
    return this.nodegitRepository.getReferences(nodegit.Reference.TYPE.OID).then((references) => {
        let getCommitPromises = [];
        references.forEach((reference) => {
            let isbranch = reference.isBranch();
            if (isbranch) {
                let commitId = reference.target().toString();
                getCommitPromises.push(this.nodegitRepository.getCommit(commitId));
            }
        });
        return Promise.all(getCommitPromises);
    }).then((commits) => {
        let parseCommitPromises = [];
        commits.forEach((commit) => {
            let prom = this.parseCommit(commit);
            if (prom != null) {
                parseCommitPromises.push(prom);
            }
        });
        return Promise.all(parseCommitPromises);
    });
};

/**
 * Abre o repositório usando nodegit e salva na base de dados.
 * @param {String} repositoryPath - Caminho do repositório.
 * @return {Promise<String>} Promise que retorna o caminho da base de dados.
 */
GitPipe.prototype.openRepository = function (repositoryPath) {
    let pathToRepo = path.resolve(repositoryPath);
    let repoRec = null;
    let dbPath = null;
    return nodegit.Repository.open(pathToRepo).then((repository) => {
        this.nodegitRepository = repository;
        // Subdiretório onde todas as bases de dados são salvas (uma para cada repositório)
        fs.mkdir('./data', () => {});
        return this.nodegitRepository.head();
    }).then((head) => {
        let headCommitId = head.target().toString();
        repoRec = new JSONDatabase.RepositoryRecord(this.nodegitRepository);
        repoRec.head = headCommitId;
        dbPath = './data/' + repoRec.name;
        this.db = new JSONDatabase(dbPath);
        this.db.setRepository(repoRec);
        return dbPath;
    }).catch((err) => {
        if (err) console.log('Error:', err);
    });
};

GitPipe.prototype.setNodegitRepository = function (nodegitRepository) {
    this.nodegitRepository = nodegitRepository;
};

GitPipe.prototype.getNodegitRepository = function () {
    return this.nodegitRepository;
};

GitPipe.prototype.setDb = function (db) {
    this.db = db;
};

GitPipe.prototype.getDb = function () {
    return this.db;
};

module.exports = GitPipe;
