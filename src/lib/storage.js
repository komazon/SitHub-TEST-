import {ScratchStorage} from '@scratch/scratch-storage';

<<<<<<< HEAD
const PROJECT_HOST = process.env.PROJECT_HOST || '/projects-data';
=======
const PROJECT_HOST = process.env.PROJECT_HOST || 'https://projects.scratch.mit.edu';
>>>>>>> 0c341c888eafddd30bd8e462800c2f0069484693

/**
 * Wrapper for ScratchStorage which adds default web sources.
 * @todo make this more configurable
 */
class Storage extends ScratchStorage {
    constructor () {
        super();
        this.addWebStore(
            [this.AssetType.Project],
            this.getProjectGetConfig.bind(this)
        );
    }

    setProjectToken (projectToken) {
        this.projectToken = projectToken;
    }

    getProjectGetConfig (projectAsset) {
        const path = `${PROJECT_HOST}/${projectAsset.assetId}`;
        const qs = this.projectToken ? `?token=${this.projectToken}` : '';
        return path + qs;
    }
}

const storage = new Storage();

export default storage;
